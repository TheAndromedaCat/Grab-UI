#!/usr/bin/env node

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const pam = require('authenticate-pam');
const { exec } = require('child_process');

const pkg = require('./package.json');

if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(pkg.version);
    process.exit(0);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MEMORY_FILE = path.join(__dirname, 'memory.json');

// Global Application State
let state = {
    featuresEnabled: { filebot: true, handbrake: true },
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    adminUsername: '', // Set on first admin visit if empty
    userConfigs: {}, // { username: [slot1, slot2, slot3] }
    userSettings: {} // { username: { localPathRoot: 'P:' } }
};

// Global State per User (Transient)
let userStates = {};

function getUserState(username) {
    if (!state.userConfigs[username]) {
        state.userConfigs[username] = [
            { type: 'movie', url: '', project: '', useFilebot: false, useHandbrake: false, fbAutoPick: true }
        ];
    }

    if (!userStates[username]) {
        userStates[username] = {
            slots: state.userConfigs[username].map(config => ({
                shell: null,
                logHistory: '',
                currentConfig: config
            }))
        };
    }
    return userStates[username];
}

function addSlot(username) {
    const userState = getUserState(username);
    if (userState.slots.length >= 3) return false;
    
    const newConfig = { type: 'movie', url: '', project: '', useFilebot: false, useHandbrake: false, fbAutoPick: true };
    state.userConfigs[username].push(newConfig);
    userState.slots.push({
        shell: null,
        logHistory: '',
        currentConfig: newConfig
    });
    saveState();
    return true;
}

function getPathForTarget(target) {
    const staging = path.join(__dirname, '__STAGING__', target);
    const outputs = path.join(__dirname, '__OUTPUTS__', target);
    if (!fs.existsSync(staging)) fs.mkdirSync(staging, { recursive: true, mode: 0o777 });
    if (!fs.existsSync(outputs)) fs.mkdirSync(outputs, { recursive: true, mode: 0o777 });
    try {
        fs.chmodSync(staging, 0o777);
        fs.chmodSync(outputs, 0o777);
    } catch (e) {}
    return { staging, outputs };
}

function saveState() {
    try { 
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2));
        fs.chmodSync(MEMORY_FILE, 0o666);
    }
    catch (e) { console.error('Error saving memory.json'); }
}

if (fs.existsSync(MEMORY_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        if (savedState.userConfigs) {
            // Migration: if someone had an object config, convert to array
            for (const user in savedState.userConfigs) {
                if (!Array.isArray(savedState.userConfigs[user])) {
                    savedState.userConfigs[user] = [savedState.userConfigs[user]];
                }
            }
            state.userConfigs = savedState.userConfigs;
        }
        if (savedState.featuresEnabled) state.featuresEnabled = { ...state.featuresEnabled, ...savedState.featuresEnabled };
        if (savedState.adminPassword) state.adminPassword = savedState.adminPassword;
        if (savedState.adminUsername) state.adminUsername = savedState.adminUsername;
        if (savedState.userSettings) state.userSettings = savedState.userSettings;
        saveState();
        console.log('State loaded and synchronized');
    } catch (e) { console.error('Error loading memory.json, using defaults'); }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h, m, s].map(v => v < 10 ? '0' + v : v).filter((v, i) => v !== '00' || i > 0).join(':');
}

const sessionMiddleware = session({
    store: new FileStore({
        path: './sessions',
        ttl: 10 * 365 * 24 * 60 * 60,
        retries: 0
    }),
    secret: 'grab-ui-secret-key',
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 10 * 365 * 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.authenticated) return next();
    res.redirect('/login.html');
};

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const normalizedUser = username.toLowerCase();
    try {
        pam.authenticate(normalizedUser, password, (err) => {
            if (err) return res.status(401).send('Authentication failed');
            req.session.authenticated = true;
            req.session.username = normalizedUser;
            res.redirect('/');
        });
    } catch (e) {
        if (process.platform === 'win32') {
            req.session.authenticated = true;
            req.session.username = normalizedUser || 'guest';
            res.redirect('/');
        } else res.status(500).send('Authentication error');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

app.get('/', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/admin.html', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function getTree(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    try {
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        return items.map(item => {
            const isDirectory = item.isDirectory();
            return {
                name: item.name, isDirectory,
                children: isDirectory ? getTree(path.join(dirPath, item.name)) : []
            };
        }).sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
    } catch (e) { return []; }
}

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.authenticated) {
        socket.disconnect();
        return;
    }

    const username = session.username;
    socket.join(username);

    const userState = getUserState(username);

    socket.emit('init-state', {
        slots: userState.slots.map(s => ({
            config: s.currentConfig,
            logs: s.logHistory,
            isRunning: !!s.shell
        })),
        features: state.featuresEnabled,
        adminUsername: state.adminUsername,
        topDir: path.basename(__dirname),
        settings: state.userSettings[username] || { localPathRoot: 'P:' }
    });

    socket.emit('user-info', username);

    socket.on('add-slot', () => {
        if (addSlot(username)) {
            io.to(username).emit('slot-added', {
                slots: userState.slots.map(s => ({
                    config: s.currentConfig,
                    logs: s.logHistory,
                    isRunning: !!s.shell
                }))
            });
        }
    });

    socket.on('remove-slot', (index) => {
        if (userState.slots.length <= 1) return;
        if (userState.slots[index].shell) userState.slots[index].shell.kill();
        state.userConfigs[username].splice(index, 1);
        userState.slots.splice(index, 1);
        saveState();
        io.to(username).emit('init-state', {
            slots: userState.slots.map(s => ({
                config: s.currentConfig,
                logs: s.logHistory,
                isRunning: !!s.shell
            })),
            features: state.featuresEnabled
        });
    });

    socket.on('get-file-details', (data) => {
        const { root, filePath } = data;
        const rootPath = path.join(__dirname, root === 'staging' ? '__STAGING__' : '__OUTPUTS__');
        const fullPath = path.join(rootPath, filePath);
        
        if (!fullPath.startsWith(rootPath)) return;
        if (!fs.existsSync(fullPath) || fs.lstatSync(fullPath).isDirectory()) return;

        const stats = fs.statSync(fullPath);
        const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${fullPath}"`;
        exec(cmd, (error, stdout) => {
            if (error) return socket.emit('file-details', { 
                name: path.basename(fullPath), 
                path: path.relative(__dirname, fullPath),
                size: formatBytes(stats.size), 
                error: 'Metadata probe failed',
                root, filePath
            });
            try {
                const info = JSON.parse(stdout);
                const video = info.streams.find(s => s.codec_type === 'video') || {};
                const audio = info.streams.find(s => s.codec_type === 'audio') || {};
                
                const emitDetails = (thumbnail = null) => {
                    socket.emit('file-details', {
                        name: path.basename(fullPath),
                        path: path.relative(__dirname, fullPath),
                        size: formatBytes(stats.size),
                        duration: formatDuration(info.format.duration),
                        container: info.format.format_long_name,
                        width: video.width, height: video.height, fps: video.r_frame_rate,
                        audio_bitrate: audio.bit_rate ? formatBytes(parseInt(audio.bit_rate)) + '/s' : 'N/A',
                        channels: audio.channels, sample_rate: audio.sample_rate ? (audio.sample_rate / 1000) + ' kHz' : 'N/A',
                        thumbnail,
                        root, filePath
                    });
                };

                if (video.codec_name) {
                    const thumbCmd = `ffmpeg -ss 00:00:05 -i "${fullPath}" -vframes 1 -vf "scale=640:-1" -f image2pipe -vcodec mjpeg -`;
                    exec(thumbCmd, { encoding: 'buffer', maxBuffer: 1024 * 1024 }, (tErr, tStdout) => {
                        emitDetails(tErr ? null : tStdout.toString('base64'));
                    });
                } else {
                    emitDetails();
                }
            } catch (e) { socket.emit('file-details', { name: path.basename(fullPath), size: formatBytes(stats.size), error: 'Metadata parsing failed', root, filePath }); }
        });
    });

    socket.on('update-settings', (settings) => {
        state.userSettings[username] = { ...(state.userSettings[username] || {}), ...settings };
        saveState();
        socket.emit('settings-updated', state.userSettings[username]);
    });

    socket.on('set-admin-username', (newAdmin) => {
        if (!state.adminUsername && newAdmin) {
            state.adminUsername = newAdmin.toLowerCase();
            saveState();
            io.emit('admin-username-set', state.adminUsername);
        }
    });

    socket.on('admin-login', (pass) => {
        if ((state.adminUsername && username === state.adminUsername) || pass === state.adminPassword) {
            socket.emit('login-success', state.featuresEnabled);
        } else {
            socket.emit('login-error', 'Invalid admin password');
        }
    });

    socket.on('update-features', (data) => {
        if ((state.adminUsername && username === state.adminUsername) || data.pass === state.adminPassword) {
            state.featuresEnabled = data.features;
            saveState();
            io.emit('features-updated', state.featuresEnabled);
        }
    });

    socket.on('change-password', (data) => {
        if (data.oldPass === state.adminPassword) {
            state.adminPassword = data.newPass;
            saveState();
            socket.emit('password-changed', { success: true });
        } else socket.emit('password-changed', { success: false, message: 'Current password incorrect' });
    });

    socket.on('update-config', (data) => {
        const { index, config } = data;
        if (!userState.slots[index]) return;
        state.userConfigs[username][index] = { ...state.userConfigs[username][index], ...config };
        userState.slots[index].currentConfig = state.userConfigs[username][index];
        saveState();
        io.to(username).emit('config-updated', { index, config: userState.slots[index].currentConfig });
    });

    socket.on('resize', (data) => { 
        const { index, cols, rows } = data;
        if (userState.slots[index] && userState.slots[index].shell) {
            userState.slots[index].shell.resize(cols, rows); 
        }
    });

    socket.on('run-command', (data) => {
        const { index, config } = data;
        const slot = userState.slots[index];
        if (!slot || slot.shell) return;

        state.userConfigs[username][index] = { ...state.userConfigs[username][index], ...config };
        slot.currentConfig = state.userConfigs[username][index];
        saveState();
        
        io.to(username).emit('config-updated', { index, config: slot.currentConfig });
        slot.logHistory = `[System] Starting process in slot ${index + 1} for user: ${username}...\n`;
        io.to(username).emit('clear-terminal', { index });
        io.to(username).emit('output', { index, data: slot.logHistory });

        const { type, url, fbAutoPick, project } = config;
        let { useFilebot, useHandbrake } = config;

        if (!state.featuresEnabled.filebot) useFilebot = false;
        if (!state.featuresEnabled.handbrake) useHandbrake = false;

        const activePaths = getPathForTarget(project || username);
        const baseStaging = path.join(__dirname, '__STAGING__');
        const baseOutputs = path.join(__dirname, '__OUTPUTS__');

        slot.shell = pty.spawn('bash', ['grab.sh'], {
            name: 'xterm-color', 
            cols: parseInt(config.cols) || 80, 
            rows: parseInt(config.rows) || 24,
            cwd: process.cwd(), 
            env: {
                ...process.env,
                STAGING_DIR_OVERRIDE: activePaths.staging,
                OUTPUT_DIR_OVERRIDE: activePaths.outputs, // FileBot organizes into the project folder
                BASE_STAGING: baseStaging,
                BASE_OUTPUTS: baseOutputs
            }
        });

        slot.shell.onData((d) => {
            slot.logHistory += d;
            if (slot.logHistory.length > 50000) slot.logHistory = slot.logHistory.slice(-50000);
            io.to(username).emit('output', { index, data: d });
        });

        slot.shell.onExit(({ exitCode }) => {
            const msg = `\r\n\x1b[32m[System] Process finished with exit code ${exitCode}\x1b[0m\r\n`;
            slot.logHistory += msg; 
            io.to(username).emit('output', { index, data: msg });
            slot.shell = null; 
            io.to(username).emit('process-exit', { index });
            io.emit('tree-data', { 
                staging: getTree(path.join(__dirname, '__STAGING__')), 
                outputs: getTree(path.join(__dirname, '__OUTPUTS__')) 
            });
        });

        setTimeout(() => {
            if (!slot.shell) return;
            slot.shell.write(useFilebot ? 'y\n' : 'n\n');
            if (useFilebot) {
                slot.shell.write(fbAutoPick ? 'y\n' : 'n\n');
                slot.shell.write(type === 'filebot-only' ? 'y\n' : 'n\n');
            }
            if (type !== 'filebot-only') {
                slot.shell.write(useHandbrake ? 'y\n' : 'n\n');
                if (useHandbrake) slot.shell.write(type === 'transcode-only' ? 'y\n' : 'n\n');
                if (type !== 'transcode-only') {
                    slot.shell.write(type === 'movie' ? 'M\n' : 'S\n');
                    slot.shell.write(`${url}\n`);
                }
            }
        }, 500);
    });

    socket.on('get-tree', () => {
        socket.emit('tree-data', { 
            staging: getTree(path.join(__dirname, '__STAGING__')), 
            outputs: getTree(path.join(__dirname, '__OUTPUTS__')) 
        });
    });
    
    socket.on('input', (data) => { 
        const { index, input } = data;
        if (userState.slots[index] && userState.slots[index].shell) {
            userState.slots[index].shell.write(input); 
        }
    });

    socket.on('kill', (index) => {
        const slot = userState.slots[index];
        if (slot && slot.shell) {
            slot.shell.kill(); 
            slot.shell = null;
            const msg = '\r\n\x1b[31m[System] Process killed by user.\x1b[0m\r\n';
            slot.logHistory += msg; 
            io.to(username).emit('output', { index, data: msg }); 
            io.to(username).emit('process-exit', { index });
        }
    });

    // Periodic tree refresh
    const treeInterval = setInterval(() => {
        socket.emit('tree-data', { 
            staging: getTree(path.join(__dirname, '__STAGING__')), 
            outputs: getTree(path.join(__dirname, '__OUTPUTS__')) 
        });
    }, 10000);

    socket.on('disconnect', () => {
        clearInterval(treeInterval);
        socket.leave(username);
    });
});

const PORT = process.env.PORT || 2026;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
