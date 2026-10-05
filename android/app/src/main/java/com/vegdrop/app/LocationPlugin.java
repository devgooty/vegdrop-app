package com.vegdrop.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * What the page's location sheet (src/components/LocationRequiredSheet.jsx)
 * asks of the phone. The site is loaded from its live URL, so it reaches this
 * through the injected bridge — window.Capacitor.nativePromise — rather than an
 * npm package bundled into it (src/services/nativeLocation.js).
 *
 * Every call resolves with the same snapshot:
 *   granted — the app may read a position (approximate is enough)
 *   blocked — Android will not ask again; only Settings can grant it
 *   enabled — the device's location is switched on
 */
@CapacitorPlugin(
    name = "VegDropLocation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class LocationPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(snapshot());
    }

    /** Ask for the permission if needed, then for location to be switched on. */
    @PluginMethod
    public void enable(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity.hasLocationPermission()) {
            ensureLocationOn(call);
            return;
        }
        if (getPermissionState("location") == PermissionState.DENIED) {
            // "Don't ask again": a request would resolve at once without showing
            // anything, which reads as a button that does nothing.
            openAppSettings();
            JSObject result = snapshot();
            result.put("openedSettings", true);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("location", call, "afterPermission");
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (!((MainActivity) getActivity()).hasLocationPermission()) {
            call.resolve(snapshot());
            return;
        }
        ensureLocationOn(call);
    }

    private void ensureLocationOn(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity.isLocationOn()) {
            call.resolve(snapshot());
            return;
        }
        activity.promptEnableLocation((on) -> call.resolve(snapshot()));
    }

    private void openAppSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            getActivity().startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // Nothing to open; the sheet still offers to pick an address by hand.
        }
    }

    private JSObject snapshot() {
        MainActivity activity = (MainActivity) getActivity();
        boolean granted = activity.hasLocationPermission();
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("blocked", !granted && getPermissionState("location") == PermissionState.DENIED);
        result.put("enabled", activity.isLocationOn());
        return result;
    }
}
