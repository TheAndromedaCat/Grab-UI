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

// Default State
let state = {
    currentConfig: { 
        type: 'movie', 
        url: '', 
        useFilebot: false, 
        useHandbrake: false,
        fbAutoPick: true 
    },
    featuresEnabled: { filebot: true, handbrake: true },
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
};

function saveState() {
    try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(state, null, 2)); }
    catch (e) { console.error('Error saving memory.json'); }
}

if (fs.existsSync(MEMORY_FILE)) {
    try {
        const savedState = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        if (savedState.currentConfig) state.currentConfig = { ...state.currentConfig, ...savedState.currentConfig };
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
    try {
        pam.authenticate(username, password, (err) => {
            if (err) return res.status(401).send('Authentication failed');
            req.session.authenticated = true;
            req.session.username = username;
            res.redirect('/');
        });
    } catch (e) {
        if (process.platform === 'win32') {
            req.session.authenticated = true;
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

let shell = null;
let logHistory = '';

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

    socket.emit('init-state', {
        config: state.currentConfig,
        logs: logHistory,
        isRunning: !!shell,
        features: state.featuresEnabled
    });

    socket.emit('user-info', session.username);

    socket.on('get-file-details', (data) => {
        const { root, filePath } = data;
        const fullPath = path.join(__dirname, root === 'staging' ? '__STAGING__' : '__OUTPUTS__', filePath);
        if (!fullPath.startsWith(path.join(__dirname, '__STAGING__')) && !fullPath.startsWith(path.join(__dirname, '__OUTPUTS__'))) return;
        if (!fs.existsSync(fullPath) || fs.lstatSync(fullPath).isDirectory()) return;

        const stats = fs.statSync(fullPath);
        const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${fullPath}"`;
        exec(cmd, (error, stdout) => {
            if (error) return socket.emit('file-details', { 
                name: path.basename(fullPath), 
                path: path.relative(path.dirname(__dirname), fullPath),
                size: formatBytes(stats.size), 
                error: 'Metadata probe failed' 
            });
            try {
                const info = JSON.parse(stdout);
                const video = info.streams.find(s => s.codec_type === 'video') || {};
                const audio = info.streams.find(s => s.codec_type === 'audio') || {};
                socket.emit('file-details', {
                    name: path.basename(fullPath),
                    path: path.relative(path.dirname(__dirname), fullPath),
                    size: formatBytes(stats.size),
                    duration: formatDuration(info.format.duration),
                    container: info.format.format_long_name,
                    width: video.width, height: video.height, fps: video.r_frame_rate,
                    audio_bitrate: audio.bit_rate ? formatBytes(parseInt(audio.bit_rate)) + '/s' : 'N/A',
                    channels: audio.channels, sample_rate: audio.sample_rate ? (audio.sample_rate / 1000) + ' kHz' : 'N/A'
                });
            } catch (e) { socket.emit('file-details', { name: path.basename(fullPath), size: formatBytes(stats.size), error: 'Metadata parsing failed' }); }
        });
    });

    socket.on('admin-login', (pass) => {
        const username = socket.request.session ? socket.request.session.username : null;
        if (username === 'andromeda' || pass === state.adminPassword) {
            socket.emit('login-success', state.featuresEnabled);
        } else {
            socket.emit('login-error', 'Invalid admin password');
        }
    });

    socket.on('update-features', (data) => {
        const username = socket.request.session ? socket.request.session.username : null;
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
        state.currentConfig = { ...state.currentConfig, ...config };
        saveState();
        socket.broadcast.emit('config-updated', state.currentConfig);
    });

    socket.on('resize', (size) => { if (shell) shell.resize(size.cols, size.rows); });

    socket.on('run-command', (config) => {
        if (shell) return;
        state.currentConfig = config;
        saveState();
        socket.broadcast.emit('config-updated', state.currentConfig);
        logHistory = '[System] Starting process...\n';
        io.emit('clear-terminal');
        io.emit('output', logHistory);

        const { type, url, fbAutoPick } = config;
        let { useFilebot, useHandbrake } = config;

        if (!state.featuresEnabled.filebot) useFilebot = false;
        if (!state.featuresEnabled.handbrake) useHandbrake = false;

        shell = pty.spawn('bash', ['grab.sh'], {
            name: 'xterm-color', 
            cols: parseInt(config.cols) || 80, 
            rows: parseInt(config.rows) || 24,
            cwd: process.cwd(), env: process.env
        });

        shell.onData((data) => {
            logHistory += data;
            if (logHistory.length > 50000) logHistory = logHistory.slice(-50000);
            io.emit('output', data);
        });

        shell.onExit(({ exitCode }) => {
            const msg = `\r\n\x1b[32m[System] Process finished with exit code ${exitCode}\x1b[0m\r\n`;
            logHistory += msg; io.emit('output', msg);
            shell = null; io.emit('process-exit');
            io.emit('tree-data', { staging: getTree(path.join(__dirname, '__STAGING__')), outputs: getTree(path.join(__dirname, '__OUTPUTS__')) });
        });

        setTimeout(() => {
            if (!shell) return;
            shell.write(useFilebot ? 'y\n' : 'n\n');
            if (useFilebot) {
                shell.write(fbAutoPick ? 'y\n' : 'n\n');
                shell.write(type === 'filebot-only' ? 'y\n' : 'n\n');
            }
            if (type !== 'filebot-only') {
                shell.write(useHandbrake ? 'y\n' : 'n\n');
                if (useHandbrake) shell.write(type === 'transcode-only' ? 'y\n' : 'n\n');
                if (type !== 'transcode-only') {
                    shell.write(type === 'movie' ? 'M\n' : 'S\n');
                    shell.write(`${url}\n`);
                }
            }
        }, 500);
    });

    socket.on('get-tree', () => io.emit('tree-data', { staging: getTree(path.join(__dirname, '__STAGING__')), outputs: getTree(path.join(__dirname, '__OUTPUTS__')) }));
    socket.on('input', (data) => { if (shell) shell.write(data); });
    socket.on('kill', () => {
        if (shell) {
            shell.kill(); shell = null;
            const msg = '\r\n\x1b[31m[System] Process killed by user.\x1b[0m\r\n';
            logHistory += msg; io.emit('output', msg); io.emit('process-exit');
        }
    });
});

const PORT = process.env.PORT || 2026;
server.listen(PORT, '0.0.0.0', () => {
    setInterval(() => io.emit('tree-data', { staging: getTree(path.join(__dirname, '__STAGING__')), outputs: getTree(path.join(__dirname, '__OUTPUTS__')) }), 10000);
});

// END OF FILE
