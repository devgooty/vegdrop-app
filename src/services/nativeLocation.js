/**
 * The Android app's location controls (android/…/LocationPlugin.java).
 *
 * Reached through the bridge Capacitor injects into the page rather than an
 * npm package: the app loads this site from its live URL, so whatever the
 * phone can do arrives with the page, and in a browser none of it exists.
 */

const PLUGIN = 'VegDropLocation';

function bridge() {
  return typeof window === 'undefined' ? null : window.Capacitor || null;
}

/** True only inside the Android app, on a build that has the plugin. */
export function hasNativeLocation() {
  const cap = bridge();
  return Boolean(
    cap?.nativePromise &&
      Array.isArray(cap.PluginHeaders) &&
      cap.PluginHeaders.some((plugin) => plugin.name === PLUGIN)
  );
}

/** @returns {Promise<{ granted: boolean, blocked: boolean, enabled: boolean }>} */
export function nativeLocationStatus() {
  return bridge().nativePromise(PLUGIN, 'status', {});
}

/**
 * Asks for the permission if needed, then shows Android's "Turn on location".
 * A permission the user blocked opens the app's Settings page instead
 * (`openedSettings`), since Android will not show the request again.
 * @returns {Promise<{ granted: boolean, blocked: boolean, enabled: boolean, openedSettings?: boolean }>}
 */
export function enableNativeLocation() {
  return bridge().nativePromise(PLUGIN, 'enable', {});
}
