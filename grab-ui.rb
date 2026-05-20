class GrabUi < Formula
  desc "Web interface for grab.sh - Media Automation & Management"
  homepage "https://github.com/TheAndromedaCat/Grab-UI"
  url "https://github.com/TheAndromedaCat/Grab-UI/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "e34566e7e1b9d1c82d6479a0836f0e83601eddd080bcaa1b29fe8313d912e0d4"
  license "MIT"

  depends_on "node"
  depends_on "wget"
  depends_on "ffmpeg"

  # handbrake-cli is often in a separate tap or named differently
  # On Linux Homebrew, it might be available. On macOS, it's usually a cask.
  # We will list it as a recommended dependency.
  # depends_on "handbrake-cli"

  def install
    system "npm", "install", *std_npm_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Grab-UI requires PAM for authentication on Linux. Ensure 'libpam0g-dev' (Debian/Ubuntu) 
      or 'pam-devel' (RHEL/Fedora) is installed on your host system.
      
      Optional dependencies like 'handbrake-cli' and 'filebot' should be installed separately:
        brew install handbrake-cli (Linux) or brew install --cask handbrake-cli (macOS)
    EOS
  end

  test do
    system "#{bin}/grab-ui", "--version"
  end
end
