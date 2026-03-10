#!/usr/bin/env bash
#
# Open Agent Sessions (oas) Installer
# https://github.com/bhd/open-agent-sessions
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/bhd/open-agent-sessions/main/scripts/install.sh | bash
#
# Environment Variables:
#   OAS_INSTALL_DIR   - Installation directory (default: ~/.oas)
#   OAS_BIN_DIR       - Directory for oas symlink (default: ~/.local/bin)
#   OAS_REPO_URL      - Git repository URL (default: https://github.com/bhd/open-agent-sessions.git)
#   OAS_BRANCH        - Branch to install (default: main)
#   OAS_SKIP_BUN      - Skip Bun installation if already installed elsewhere
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration with environment variable overrides
OAS_INSTALL_DIR="${OAS_INSTALL_DIR:-$HOME/.oas}"
OAS_BIN_DIR="${OAS_BIN_DIR:-$HOME/.local/bin}"
OAS_REPO_URL="${OAS_REPO_URL:-https://github.com/bhd/open-agent-sessions.git}"
OAS_BRANCH="${OAS_BRANCH:-main}"
OAS_SKIP_BUN="${OAS_SKIP_BUN:-false}"

# Derived paths
OAS_REPO_DIR="$OAS_INSTALL_DIR/open-agent-sessions"
OAS_BIN_LINK="$OAS_BIN_DIR/oas"

# Helper functions
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

check_command() {
    command -v "$1" &> /dev/null
}

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    local missing=()
    
    # Check for curl or wget
    if ! check_command curl && ! check_command wget; then
        missing+=("curl or wget")
    fi
    
    # Check for git
    if ! check_command git; then
        missing+=("git")
    fi
    
    if [ ${#missing[@]} -ne 0 ]; then
        error "Missing required tools: ${missing[*]}"
        error "Please install them and try again."
        exit 1
    fi
    
    success "Prerequisites satisfied"
}

# Install Bun if not present
install_bun() {
    if check_command bun; then
        local bun_version
        bun_version=$(bun --version 2>/dev/null || echo "unknown")
        success "Bun is already installed (version: $bun_version)"
        return 0
    fi
    
    if [ "$OAS_SKIP_BUN" = "true" ]; then
        warn "OAS_SKIP_BUN is set, but Bun is not installed."
        warn "The oas CLI requires Bun to run."
        return 0
    fi
    
    info "Installing Bun..."
    
    # Use the official Bun installer
    if check_command curl; then
        curl -fsSL https://bun.sh/install | bash
    elif check_command wget; then
        wget -qO- https://bun.sh/install | bash
    else
        die "Neither curl nor wget available for Bun installation"
    fi
    
    # Add Bun to PATH for this session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    if ! check_command bun; then
        die "Bun installation failed. Please install Bun manually: https://bun.sh"
    fi
    
    success "Bun installed successfully"
}

# Clone or update the repository
setup_repository() {
    info "Setting up repository..."
    
    if [ -d "$OAS_REPO_DIR" ]; then
        info "Repository already exists at $OAS_REPO_DIR"
        info "Updating existing installation..."
        
        cd "$OAS_REPO_DIR"
        git fetch origin
        git checkout "$OAS_BRANCH"
        git reset --hard "origin/$OAS_BRANCH"
    else
        info "Cloning repository to $OAS_REPO_DIR..."
        
        mkdir -p "$OAS_INSTALL_DIR"
        git clone --branch "$OAS_BRANCH" "$OAS_REPO_URL" "$OAS_REPO_DIR"
        cd "$OAS_REPO_DIR"
    fi
    
    success "Repository ready"
}

# Install dependencies
install_dependencies() {
    info "Installing dependencies..."
    
    cd "$OAS_REPO_DIR"
    
    if ! check_command bun; then
        die "Bun is required but not found in PATH. Please install Bun first."
    fi
    
    bun install
    
    success "Dependencies installed"
}

# Create symlink to oas CLI
create_symlink() {
    info "Creating oas CLI wrapper..."
    
    # Ensure bin directory exists
    mkdir -p "$OAS_BIN_DIR"
    
    # Remove existing wrapper if it's our wrapper script
    if [ -L "$OAS_BIN_LINK" ]; then
        rm -f "$OAS_BIN_LINK"
    elif [ -e "$OAS_BIN_LINK" ]; then
        # Check if it's our wrapper script (safe to overwrite)
        if grep -q "Open Agent Sessions CLI wrapper" "$OAS_BIN_LINK" 2>/dev/null; then
            rm -f "$OAS_BIN_LINK"
        else
            warn "File exists at $OAS_BIN_LINK (not our wrapper)"
            warn "Please remove it manually or use a different OAS_BIN_DIR"
            return 1
        fi
    fi
    
    # Create wrapper script
    # Note: Using unquoted heredoc to expand $OAS_REPO_DIR at wrapper creation time
    local wrapper_script="$OAS_BIN_DIR/oas"
    cat > "$wrapper_script" << WRAPPER_EOF
#!/usr/bin/env bash
# Open Agent Sessions CLI wrapper
# This script runs the oas CLI using Bun
# Generated by install.sh with install dir: $OAS_REPO_DIR

# Resolve the installation directory (uses baked-in path from install time)
OAS_ROOT="\${OAS_ROOT:-$OAS_REPO_DIR}"
OAS_BIN="\$OAS_ROOT/bin/oas"

if [ ! -f "\$OAS_BIN" ]; then
    echo "Error: oas CLI not found at \$OAS_BIN" >&2
    echo "Please reinstall or set OAS_ROOT environment variable" >&2
    exit 1
fi

# Run the CLI with Bun
exec bun run "\$OAS_BIN" "\$@"
WRAPPER_EOF
    
    chmod +x "$wrapper_script"
    
    success "CLI wrapper created at $OAS_BIN_DIR/oas"
}

# Add bin directory to PATH if needed
add_to_path() {
    local shell_rc=""
    local add_path_instruction=""
    
    # Detect shell and config file
    if [ -n "${ZSH_VERSION:-}" ]; then
        shell_rc="$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ]; then
        if [ -f "$HOME/.bashrc" ]; then
            shell_rc="$HOME/.bashrc"
        elif [ -f "$HOME/.bash_profile" ]; then
            shell_rc="$HOME/.bash_profile"
        fi
    fi
    
    # Check if already in PATH
    if [[ ":$PATH:" == *":$OAS_BIN_DIR:"* ]]; then
        success "$OAS_BIN_DIR is already in PATH"
        return 0
    fi
    
    info "Adding $OAS_BIN_DIR to PATH..."
    
    if [ -n "$shell_rc" ] && [ -f "$shell_rc" ]; then
        # Check if already added to shell rc
        if grep -q "export PATH=\"\$PATH:$OAS_BIN_DIR\"" "$shell_rc" 2>/dev/null; then
            success "PATH export already in $shell_rc"
        else
            echo "" >> "$shell_rc"
            echo "# Added by oas installer" >> "$shell_rc"
            echo "export PATH=\"\$PATH:$OAS_BIN_DIR\"" >> "$shell_rc"
            success "Added $OAS_BIN_DIR to $shell_rc"
        fi
    else
        warn "Could not detect shell config file"
        warn "Please add the following to your shell config:"
        warn "  export PATH=\"\$PATH:$OAS_BIN_DIR\""
    fi
    
    # Add to current session
    export PATH="$PATH:$OAS_BIN_DIR"
}

# Print installation summary
print_summary() {
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Open Agent Sessions installed!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "Installation details:"
    echo "  Repository: $OAS_REPO_DIR"
    echo "  CLI:        $OAS_BIN_DIR/oas"
    echo ""
    
    # Check if oas is available
    if check_command oas; then
        echo "Try it now:"
        echo "  oas --help"
    else
        echo "To start using oas, restart your shell or run:"
        echo "  source ~/.bashrc  # or ~/.zshrc"
        echo "  oas --help"
    fi
    echo ""
    echo "To update in the future, run:"
    echo "  curl -fsSL https://raw.githubusercontent.com/bhd/open-agent-sessions/main/scripts/install.sh | bash"
    echo ""
}

# Uninstall function
uninstall() {
    info "Uninstalling Open Agent Sessions..."
    
    # Remove symlink
    if [ -L "$OAS_BIN_LINK" ] || [ -f "$OAS_BIN_LINK" ]; then
        rm -f "$OAS_BIN_LINK"
        success "Removed $OAS_BIN_LINK"
    fi
    
    # Remove installation directory
    if [ -d "$OAS_INSTALL_DIR" ]; then
        rm -rf "$OAS_INSTALL_DIR"
        success "Removed $OAS_INSTALL_DIR"
    fi
    
    echo ""
    echo "Open Agent Sessions has been uninstalled."
    echo "You may also want to remove the PATH export from your shell config."
}

# Main installation flow
main() {
    echo ""
    echo -e "${BLUE}Open Agent Sessions Installer${NC}"
    echo "================================"
    echo ""
    
    # Handle uninstall flag
    if [ "${1:-}" = "--uninstall" ]; then
        uninstall
        exit 0
    fi
    
    # Handle help flag
    if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
        echo "Usage: curl -fsSL https://raw.githubusercontent.com/bhd/open-agent-sessions/main/scripts/install.sh | bash"
        echo ""
        echo "Environment Variables:"
        echo "  OAS_INSTALL_DIR   Installation directory (default: ~/.oas)"
        echo "  OAS_BIN_DIR       Directory for oas symlink (default: ~/.local/bin)"
        echo "  OAS_REPO_URL      Git repository URL"
        echo "  OAS_BRANCH        Branch to install (default: main)"
        echo "  OAS_SKIP_BUN      Skip Bun installation (true/false)"
        echo ""
        echo "Options:"
        echo "  --uninstall       Remove Open Agent Sessions"
        echo "  --help, -h        Show this help message"
        exit 0
    fi
    
    info "Installing to: $OAS_INSTALL_DIR"
    info "CLI will be available at: $OAS_BIN_DIR/oas"
    echo ""
    
    check_prerequisites
    install_bun
    setup_repository
    install_dependencies
    create_symlink
    add_to_path
    print_summary
}

# Run main with all arguments
main "$@"
