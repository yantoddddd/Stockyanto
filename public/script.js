// =============================================
// YANTO STORE - SHARED UTILITIES v2.0
// =============================================

// Toast system
const Toast = {
    container: null,
    
    init() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            this.container.setAttribute('role', 'status');
            this.container.setAttribute('aria-live', 'polite');
            document.body.appendChild(this.container);
        }
    },
    
    show(msg, type = 'info', duration = 3500) {
        this.init();
        const toast = document.createElement('div');
        const icons = { success: 'fa-check-circle', error: 'fa-exclamation-triangle', warning: 'fa-exclamation-circle', info: 'fa-info-circle' };
        const icon = icons[type] || icons.info;
        
        toast.className = `toast ${type}`;
        toast.innerHTML = `<i class="fas ${icon}"></i> ${msg}<div class="toast-progress" style="animation-duration:${duration}ms"></div>`;
        
        this.container.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, duration);
        
        return toast;
    },
    
    success(msg, duration) { return this.show(msg, 'success', duration); },
    error(msg, duration) { return this.show(msg, 'error', duration); },
    warning(msg, duration) { return this.show(msg, 'warning', duration); },
    info(msg, duration) { return this.show(msg, 'info', duration); }
};

// Theme Manager
const Theme = {
    init() {
        const saved = localStorage.getItem('theme') || 'dark';
        this.set(saved);
    },
    
    set(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    },
    
    toggle() {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        this.set(current === 'dark' ? 'light' : 'dark');
    },
    
    get() {
        return document.documentElement.getAttribute('data-theme') || 'dark';
    }
};

// Loading Bar
const LoadingBar = {
    el: null,
    
    init() {
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.id = 'loadingBar';
            document.body.prepend(this.el);
        }
    },
    
    show() {
        this.init();
        this.el.classList.add('loading');
    },
    
    hide() {
        this.init();
        this.el.classList.remove('loading');
    }
};

// Offline Detector
const OfflineDetector = {
    banner: null,
    
    init() {
        this.banner = document.createElement('div');
        this.banner.id = 'offlineBanner';
        this.banner.innerHTML = '<i class="fas fa-wifi-slash"></i> Koneksi terputus. Mencoba menyambungkan...';
        this.banner.setAttribute('role', 'alert');
        document.body.prepend(this.banner);
        
        window.addEventListener('online', () => {
            this.banner.classList.remove('show');
            Toast.success('Koneksi kembali!');
        });
        
        window.addEventListener('offline', () => {
            this.banner.classList.add('show');
            Toast.error('Koneksi terputus!');
        });
        
        if (!navigator.onLine) {
            this.banner.classList.add('show');
        }
    }
};

// Back to Top
const BackToTop = {
    btn: null,
    
    init() {
        this.btn = document.createElement('button');
        this.btn.id = 'backToTop';
        this.btn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        this.btn.setAttribute('aria-label', 'Kembali ke atas');
        this.btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
        document.body.appendChild(this.btn);
        
        let ticking = false;
        window.addEventListener('scroll', () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    if (window.scrollY > 400) {
                        this.btn.classList.add('show');
                    } else {
                        this.btn.classList.remove('show');
                    }
                    ticking = false;
                });
                ticking = true;
            }
        });
    }
};

// Escape HTML
function escapeHtml(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(str).replace(/[&<>"']/g, m => map[m]);
}

// Debounce
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Copy to clipboard
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        Toast.success('📋 Tersalin!');
        if (navigator.vibrate) navigator.vibrate(50);
    } catch(e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        Toast.success('📋 Tersalin!');
    }
}

// Share
async function shareContent(title, text, url) {
    if (navigator.share) {
        try {
            await navigator.share({ title, text, url });
        } catch(e) {}
    } else {
        copyToClipboard(url || text);
        Toast.info('Link disalin!');
    }
}

// Format currency
function formatCurrency(amount) {
    return 'Rp ' + (amount || 0).toLocaleString('id-ID');
}

// Format date
function formatDate(dateStr, options = {}) {
    const d = new Date(dateStr);
    const defaults = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleString('id-ID', { ...defaults, ...options });
}

// Time ago
function timeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = now - then;
    
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'Baru saja';
    if (minutes < 60) return minutes + ' menit lalu';
    if (hours < 24) return hours + ' jam lalu';
    if (days < 7) return days + ' hari lalu';
    return formatDate(dateStr);
}

// Ripple effect
function addRipple(e) {
    const btn = e.currentTarget;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
}

// Apply ripple to all buttons
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.btn, button:not(.no-ripple)').forEach(btn => {
        btn.classList.add('relative');
        btn.addEventListener('click', addRipple);
    });
});

// Keyboard shortcuts manager
const Shortcuts = {
    shortcuts: {},
    
    register(key, callback, description = '') {
        this.shortcuts[key.toLowerCase()] = { callback, description };
    },
    
    init() {
        document.addEventListener('keydown', (e) => {
            const key = [];
            if (e.ctrlKey || e.metaKey) key.push('ctrl');
            if (e.shiftKey) key.push('shift');
            if (e.altKey) key.push('alt');
            key.push(e.key.toLowerCase());
            
            const combo = key.join('+');
            const shortcut = this.shortcuts[combo];
            
            if (shortcut && !e.target.closest('input, textarea, [contenteditable]')) {
                e.preventDefault();
                shortcut.callback(e);
            }
        });
    },
    
    getHelp() {
        return Object.entries(this.shortcuts)
            .map(([key, { description }]) => `${key}: ${description}`)
            .join('\n');
    }
};

// Focus trap for modals
function trapFocus(modalElement) {
    const focusable = modalElement.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    
    modalElement.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    });
    
    first?.focus();
}

// Fetch with retry
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (!res.ok && i < retries - 1) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch(e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, backoff * Math.pow(2, i)));
        }
    }
}

// Initialize shared features
document.addEventListener('DOMContentLoaded', () => {
    Theme.init();
    OfflineDetector.init();
    BackToTop.init();
    Shortcuts.init();
    
    // Escape closes modals
    Shortcuts.register('escape', () => {
        const modals = document.querySelectorAll('.modal-overlay.active, [role="dialog"][style*="display: flex"]');
        modals.forEach(m => {
            if (m.onclick) m.onclick({ target: m });
            else m.style.display = 'none';
        });
    }, 'Tutup modal');
});

// ========== PWA REGISTRATION ==========
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('✅ SW registered'))
            .catch(err => console.log('SW not registered', err));
    });
}
