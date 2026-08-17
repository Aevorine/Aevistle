/**
 * Android's own view of the permissions it granted (notifications, exact
 * alarms, battery optimisation) and the actions that request or open the
 * settings screen for each — moved out of `AppState.tsx`'s `AppProvider`
 * unchanged, see that file for how this is wired in.
 *
 * A no-op on desktop and web: `bridge` there has none of these methods, so
 * every branch below falls through its optional chaining and `permissions`
 * stays `null`.
 */

import { useCallback, useEffect, useState } from 'react'
import type { AndroidPermissionApi } from '../../core/platform/bridge-android'
import type { PlatformBridge } from '../../core/platform/bridge'
import type { PermissionSnapshot } from '../../core/ops/health'

export interface AndroidPermissionsApi {
  permissions: PermissionSnapshot | null
  fixPermission: (
    what:
      | 'requestNotifications'
      | 'openNotificationSettings'
      | 'openExactAlarmSettings'
      | 'openBatteryOptimizationSettings'
      | 'openAutoStartSettings',
  ) => Promise<void>
}

export function useAndroidPermissions(bridge: PlatformBridge | null): AndroidPermissionsApi {
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null)

  /**
   * Read Android's view of its own permissions, now and whenever the window
   * comes back to the foreground.
   *
   * The foreground check is the load-bearing half. Both of these are changed on
   * a system settings screen, which means leaving the app — so the only moment
   * the answer can have changed is the moment we return. Without it the strip
   * would keep saying "notifications are off" after the user had just turned
   * them on, which reads as the fix not working.
   */
  useEffect(() => {
    if (!bridge) return
    const android = bridge as Partial<AndroidPermissionApi>
    if (!android.permissionState) return
    let live = true
    const read = () => {
      android
        .permissionState?.()
        .then((s) => {
          if (live) setPermissions(s)
        })
        // A permission read that fails tells us nothing, and there is nothing
        // the user could do about it. Leaving the previous answer in place is
        // better than flapping the strip.
        .catch(() => {})
    }
    read()
    const onVisible = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [bridge])

  const fixPermission = useCallback(
    async (
      what:
        | 'requestNotifications'
        | 'openNotificationSettings'
        | 'openExactAlarmSettings'
        | 'openBatteryOptimizationSettings'
        | 'openAutoStartSettings',
    ) => {
      const android = bridge as Partial<AndroidPermissionApi> | null
      if (!android) return
      try {
        if (what === 'requestNotifications') {
          const after = await android.requestNotificationPermission?.()
          if (after) setPermissions(after)
          return
        }
        // The settings/dialog routes answer nothing themselves — the result
        // arrives via the visibility listener above, when the user comes back.
        if (what === 'openNotificationSettings') await android.openNotificationSettings?.()
        else if (what === 'openExactAlarmSettings') await android.openExactAlarmSettings?.()
        // Named rather than left to the `else`, which now has two candidates:
        // an unnamed fallback would have quietly sent the auto-start button to
        // the battery dialog, which opens, looks like it worked, and changes
        // nothing about the list that was actually stopping the service.
        else if (what === 'openAutoStartSettings') await android.openAutoStartSettings?.()
        else await android.openBatteryOptimizationSettings?.()
      } catch {
        // Same reasoning as the read: an OEM build with no such screen is not
        // something to throw a dialog about.
      }
    },
    [bridge],
  )

  return { permissions, fixPermission }
}
