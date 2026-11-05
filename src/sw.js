self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(self.registration.showNotification('Nuevo mensaje', {
    body: 'Abre el chat para ver la conversación.',
    data: {cid: data.cid},
    tag: data.cid || 'chat',
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = '/?chat=' + encodeURIComponent(event.notification.data?.cid ?? '');
  event.waitUntil(self.clients.openWindow(path));
});
