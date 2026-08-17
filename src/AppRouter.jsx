import React, { useState, useEffect, Suspense, lazy } from 'react';
import SplashScreen from './components/SplashScreen';

/**
 * Hash-based routing between the three role apps.
 *
 * Each app is code-split. A customer opening the storefront should not download
 * the shopkeeper inventory tooling or the delivery map stack — those are large
 * (Leaflet alone is substantial) and irrelevant to them. Splitting here is the
 * single highest-leverage cut because the three apps share almost no leaf
 * components.
 */
const App = lazy(() => import('./App'));
const ShopkeeperApp = lazy(() => import('./ShopkeeperApp'));
const DeliveryApp = lazy(() => import('./DeliveryApp'));

function getRoute() {
  const hash = window.location.hash.replace('#', '') || '/';
  if (hash.startsWith('/shopkeeper')) return 'shopkeeper';
  if (hash.startsWith('/delivery')) return 'delivery';
  return 'customer';
}

export default function AppRouter() {
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const Active =
    route === 'shopkeeper' ? ShopkeeperApp : route === 'delivery' ? DeliveryApp : App;

  return (
    // The splash doubles as the chunk-loading state, so switching routes never
    // shows a blank frame. No `onComplete` here on purpose: there is nothing to
    // hand over to until the chunk resolves, so the splash assembles and then
    // holds. With a no-op it faded itself to transparent after ~2.5s and left a
    // blank screen behind on any connection slower than that.
    //
    // `edition` is passed even though the app inside the chunk will render its
    // own splash with the same value: the route is known here and the chunk is
    // not, so without it a shopkeeper's launch began under the customer brand
    // line and changed word once the download landed.
    <Suspense fallback={<SplashScreen edition={route === 'customer' ? undefined : route} />}>
      <Active />
    </Suspense>
  );
}
