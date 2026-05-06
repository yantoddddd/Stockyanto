// =============================================
// YANTO STORE - SERVICE WORKER v2.0
// =============================================

const CACHE_NAME = 'yanto-store-v2';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/order.html',
    '/admin.html',
    '/ketentuan.html',
    '/unauthorized.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700;14..32,800;14..32,900&display=swap'
];

const API_CACHE_NAME = 'yanto-store-api-v2';

// Install - cache static assets
self.addEventListener('install', (event) => {
    console.log('👷 Service Worker: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate - cleanup old caches
self.addEventListener('activate', (event) => {
    console.log('✅ Service Worker: Activated');
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME && key !== API_CACHE_NAME)
                    .map(key => {
                        console.log('🗑️ Deleting old cache:', key);
                        return caches.delete(key);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch - stale-while-revalidate for API, cache-first for static
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Skip non-GET requests
    if (request.method !== 'GET') return;
    
    // API requests - network first, fallback to cache
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirst(request));
    }
    // Static assets - cache first, fallback to network
    else {
        event.respondWith(cacheFirst(request));
    }
});

// Network first strategy (for API)
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        // Cache successful GET responses
        if (response.ok) {
            const cache = await caches.open(API_CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        console.log('⚠️ Offline, trying cache:', request.url);
        const cached = await caches.match(request);
        if (cached) return cached;
        // Return offline JSON
        return new Response(JSON.stringify({ 
            success: false, 
            error: 'Offline',
            offline: true 
        }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

// Cache first strategy (for static)
async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        // Offline fallback for navigation
        if (request.mode === 'navigate') {
            return caches.match('/index.html');
        }
        throw error;
    }
}

// Handle messages
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'CACHE_NEW_VERSION') {
        caches.open(CACHE_NAME).then(cache => {
            cache.addAll(STATIC_ASSETS);
        });
    }
});

// Push notifications
self.addEventListener('push', (event) => {
    if (!event.data) return;
    
    const data = event.data.json();
    const options = {
        body: data.body || 'Ada pesanan baru!',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        vibrate: [200, 100, 200],
        data: { url: data.url || '/' },
        actions: data.actions || []
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'Yanto Store', options)
    );
});

// Notification click
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    if (event.notification.data?.url) {
        event.waitUntil(
            clients.matchAll({ type: 'window' }).then(clientList => {
                for (const client of clientList) {
                    if (client.url === event.notification.data.url && 'focus' in client) {
                        return client.focus();
                    }
                }
                return clients.openWindow(event.notification.data.url);
            })
        );
    }
});
