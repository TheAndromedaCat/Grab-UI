class GrabUi < Formula
  desc "Web interface for grab.sh - Media Automation & Management"
  homepage "https://github.com/TheAndromedaCat/Grab-UI"
  url "https://github.com/TheAndromedaCat/Grab-UI/archive/refs/tags/v1.0.1.tar.gz"
  sha256 "4542caa5a565d871f26716059807b835251e634e726fc9c60007c18144e00f3a"
  license "MIT"

  depends_on "node"
  depends_on "wget"
  depends_on "ffmpeg"

  # handbrake-cli is often in a separate tap or named differently
  # On Linux Homebrew, it might be available. On macOS, it's usually a cask.
  # We will list it as a recommended dependency.
  # depends_on "handbrake-cli"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"grab-ui"]
    keep_alive true
    error_log_path var/"log/grab-ui.log"
    log_path var/"log/grab-ui.log"
    working_dir var/"grab-ui"
  end

  def post_install
    (var/"grab-ui").mkpath
    (var/"log").mkpath
  end

  def caveats
    <<~EOS
      Grab-UI requires PAM for authentication on Linux. Ensure 'libpam0g-dev' (Debian/Ubuntu) 
      or 'pam-devel' (RHEL/Fedora) is installed on your host system.
      
      To start Grab-UI as a background service:
        brew services start grab-ui

      Alternatively, you can use PM2 to manage the process:
        pm2 start #{opt_bin}/grab-ui --name grab-ui

      Optional dependencies like 'handbrake-cli' and 'filebot' should be installed separately:
        brew install handbrake-cli (Linux) or brew install --cask handbrake-cli (macOS)
    EOS
  end

  test do
    system "#{bin}/grab-ui", "--version"
  end
end
