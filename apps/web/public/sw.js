// The dashboard's service worker (F21): it exists to show a Web Push message as a system notification
// and to open the card when the notification is clicked. The control plane sends one JSON object per
// push, encrypted for this browser: {title, body, link, kind, eventId}. Nothing is cached here and no
// request is intercepted — this worker has no `fetch` handler on purpose.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title =
    typeof message.title === "string" && message.title !== ""
      ? message.title
      : "factory needs you";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      // One notification per event: a retry of a push replaces it rather than stacking.
      tag: typeof message.eventId === "string" ? message.eventId : undefined,
      data: { link: typeof message.link === "string" ? message.link : "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data ? event.notification.data.link : "";
  // Only a web link is opened: the payload is the control plane's, but a click never runs anything else.
  if (!/^https?:\/\//.test(link)) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find((client) => client.url === link);
        return open ? open.focus() : self.clients.openWindow(link);
      }),
  );
});
