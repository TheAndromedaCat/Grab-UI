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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MEMORY_FILE = path.join(__dirname, 'memory.json');

// Global Application State
let state = {
    featuresEnabled: { filebot: true, handbrake: true },
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    userConfigs: {}
};

// Global State per User (Transient)
let userStates = {};

function getUserState(username) {
    if (!state.userConfigs[username]) {
        state.userConfigs[username] = { 
            type: 'movie', 
            url: '', 
            project: '',
            useFilebot: false, 
            useHandbrake: false,
            fbAutoPick: true 
        };
    }

    if (!userStates[username]) {
        userStates[username] = {
            shell: null,
            logHistory: '',
            currentConfig: state.userConfigs[username]
        };
    }
    return userStates[username];
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

function getUserPaths(username) {
    return getPathForTarget(username);
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
        if (savedState.userConfigs) state.userConfigs = savedState.userConfigs;
        if (savedState.featuresEnabled) state.featuresEnabled = { ...state.featuresEnabled, ...savedState.featuresEnabled };
        if (savedState.adminPassword) state.adminPassword = savedState.adminPassword;
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
    const userPaths = getUserPaths(username);

    socket.emit('init-state', {
        config: userState.currentConfig,
        logs: userState.logHistory,
        isRunning: !!userState.shell,
        features: state.featuresEnabled
    });

    socket.emit('user-info', username);

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
                socket.emit('file-details', {
                    name: path.basename(fullPath),
                    path: path.relative(__dirname, fullPath),
                    size: formatBytes(stats.size),
                    duration: formatDuration(info.format.duration),
                    container: info.format.format_long_name,
                    width: video.width, height: video.height, fps: video.r_frame_rate,
                    audio_bitrate: audio.bit_rate ? formatBytes(parseInt(audio.bit_rate)) + '/s' : 'N/A',
                    channels: audio.channels, sample_rate: audio.sample_rate ? (audio.sample_rate / 1000) + ' kHz' : 'N/A',
                    root, filePath
                });
            } catch (e) { socket.emit('file-details', { name: path.basename(fullPath), size: formatBytes(stats.size), error: 'Metadata parsing failed', root, filePath }); }
        });
    });

    socket.on('admin-login', (pass) => {
        if (username === 'andromeda' || pass === state.adminPassword) {
            socket.emit('login-success', state.featuresEnabled);
        } else {
            socket.emit('login-error', 'Invalid admin password');
        }
    });

    socket.on('update-features', (data) => {
        if (username === 'andromeda' || data.pass === state.adminPassword) {
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

    socket.on('update-config', (config) => {
        state.userConfigs[username] = { ...state.userConfigs[username], ...config };
        userState.currentConfig = state.userConfigs[username];
        saveState();
        io.to(username).emit('config-updated', userState.currentConfig);
    });

    socket.on('resize', (size) => { if (userState.shell) userState.shell.resize(size.cols, size.rows); });

    socket.on('run-command', (config) => {
        if (userState.shell) return;
        state.userConfigs[username] = { ...state.userConfigs[username], ...config };
        userState.currentConfig = state.userConfigs[username];
        saveState();
        io.to(username).emit('config-updated', userState.currentConfig);
        userState.logHistory = `[System] Starting process for user: ${username}...\n`;
        io.to(username).emit('clear-terminal');
        io.to(username).emit('output', userState.logHistory);

        const { type, url, fbAutoPick, project } = config;
        let { useFilebot, useHandbrake } = config;

        if (!state.featuresEnabled.filebot) useFilebot = false;
        if (!state.featuresEnabled.handbrake) useHandbrake = false;

        const activePaths = getPathForTarget(project || username);

        userState.shell = pty.spawn('bash', ['grab.sh'], {
            name: 'xterm-color', 
            cols: parseInt(config.cols) || 80, 
            rows: parseInt(config.rows) || 24,
            cwd: process.cwd(), 
            env: {
                ...process.env,
                STAGING_DIR_OVERRIDE: activePaths.staging,
                OUTPUT_DIR_OVERRIDE: activePaths.outputs
            }
        });

        userState.shell.onData((data) => {
            userState.logHistory += data;
            if (userState.logHistory.length > 50000) userState.logHistory = userState.logHistory.slice(-50000);
            io.to(username).emit('output', data);
        });

        userState.shell.onExit(({ exitCode }) => {
            const msg = `\r\n\x1b[32m[System] Process finished with exit code ${exitCode}\x1b[0m\r\n`;
            userState.logHistory += msg; 
            io.to(username).emit('output', msg);
            userState.shell = null; 
            io.to(username).emit('process-exit');
            io.emit('tree-data', { 
                staging: getTree(path.join(__dirname, '__STAGING__')), 
                outputs: getTree(path.join(__dirname, '__OUTPUTS__')) 
            });
        });

        setTimeout(() => {
            if (!userState.shell) return;
            userState.shell.write(useFilebot ? 'y\n' : 'n\n');
            if (useFilebot) {
                userState.shell.write(fbAutoPick ? 'y\n' : 'n\n');
                userState.shell.write(type === 'filebot-only' ? 'y\n' : 'n\n');
            }
            if (type !== 'filebot-only') {
                userState.shell.write(useHandbrake ? 'y\n' : 'n\n');
                if (useHandbrake) userState.shell.write(type === 'transcode-only' ? 'y\n' : 'n\n');
                if (type !== 'transcode-only') {
                    userState.shell.write(type === 'movie' ? 'M\n' : 'S\n');
                    userState.shell.write(`${url}\n`);
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
    
    socket.on('input', (data) => { if (userState.shell) userState.shell.write(data); });
    socket.on('kill', () => {
        if (userState.shell) {
            userState.shell.kill(); 
            userState.shell = null;
            const msg = '\r\n\x1b[31m[System] Process killed by user.\x1b[0m\r\n';
            userState.logHistory += msg; 
            io.to(username).emit('output', msg); 
            io.to(username).emit('process-exit');
        }
    });

    // Periodic tree refresh for this user's active session
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

// END OF FILE
