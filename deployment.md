# Deployment Guide

## 1. Prerequisites
Ensure you have the following installed on your system:
- **Node.js** (v16+)
- **PM2** (Install via `npm install -g pm2`)
- **System Dependencies** for `grab.sh`:
  - `bash`, `wget`, `curl`, `file`
  - `HandBrakeCLI` (optional, for transcoding)
  - `filebot` (optional, for renaming)
  - `libpam0g-dev` (required for Linux authentication - install via `sudo apt install libpam0g-dev`)

## 2. Installation
Clone the repository and install the Node.js dependencies:
```bash
npm install
```

## 3. Starting the Server
Use PM2 to start the server and keep it running in the background:
```bash
pm2 start index.js --name "grab-ui"
```

## 4. Management Commands
- **View Logs:** `pm2 logs grab-ui`
- **Stop Server:** `pm2 stop grab-ui`
- **Restart Server:** `pm2 restart grab-ui`
- **Status:** `pm2 status`

The web interface will be available at `http://localhost:2026`.
 to manage