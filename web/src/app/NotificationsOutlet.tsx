// Port of app/notifications.tpl.html and its container in index.html (AC-NOT-03): one Bootstrap alert
// per current notification, each with a close button. Not rendered at all when there are none
// (legacy: ng-show on the container).
import { remove } from '../notifications/store.ts'
import { useNotifications } from '../notifications/useNotifications.ts'

export function NotificationsOutlet() {
  const notifications = useNotifications()
  if (notifications.length === 0) return null
  return (
    <div className="container-fluid">
      {notifications.map((notification) => (
        <div key={notification.id} className={`alert alert-${notification.type}`}>
          <button type="button" className="close" onClick={() => remove(notification)}>
            x
          </button>
          {notification.message}
        </div>
      ))}
    </div>
  )
}
