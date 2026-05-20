class GrabUi < Formula
  desc "Web interface for grab.sh - Media Automation & Management"
  homepage "https://github.com/TheAndromedaCat/Grab-UI"
  url "https://github.com/TheAndromedaCat/Grab-UI/archive/refs/tags/v1.0.2.tar.gz"
  sha256 "e4493db455c3ad33bb66e3f7d277b6bb945225735fa79b26a4ac330fab7c0ba0"
  license "MIT"

  depends_on "node"
  depends_on "wget"
  depends_on "ffmpeg"

  def install
    system "npm", "install", *std_npm_args
    # Rebuild native modules (like node-pty) for the local environment
    system "npm", "rebuild"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"grab-ui"]
    keep_alive true
    environment_variables DATA_DIR: var/"grab-ui"
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
      Grab-UI saves data (downloads and configuration) to:
        #{var}/grab-ui

      To start Grab-UI as a background service:
        brew services start grab-ui

      Alternatively, to start with PM2:
        DATA_DIR=#{var}/grab-ui pm2 start #{opt_bin}/grab-ui --name grab-ui

      Note: If using PM2, ensure you are running it as a user with write 
      permissions to #{var}/grab-ui.
    EOS
  end

  test do
    system "#{bin}/grab-ui", "--version"
  end
end
