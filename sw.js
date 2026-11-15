// سرویس‌ورکر حداقلی: فقط برای نصب‌پذیری. عمداً چیزی کش نمی‌کند تا قیمت‌ها قدیمی نشوند.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
