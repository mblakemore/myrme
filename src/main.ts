import { App } from './game';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

// The app shell decides between the title menu and a direct boot into a map (any D21 URL param:
// `map`, `faction`, `seed`, `autostart`, `shot`, `fixture`, `ants`, `frozen`). A direct boot is
// synchronous: `window.__myrme` exists as soon as this module has run, as before.
new App(root, location.search).boot();
