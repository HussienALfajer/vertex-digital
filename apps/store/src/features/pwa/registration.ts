/** Dispatched on `window` when installing becomes possible or stops being so (install.ts). */
export const INSTALL_EVENT = 'vd-install';

/**
 * SW2 and IN1, inline in the layout's head so no bundle JS joins any page's first load: registers
 * `/sw.js` after `load` where service workers exist, and keeps Chromium's `beforeinstallprompt`
 * on `window.__vdInstall` (no mini-infobar: "ثبّت التطبيق" offers it) until `appinstalled`.
 * S26 SP1: under a merchant's shop (`/s/<slug>/`) it registers that shop's own worker, scoped to
 * the shop, so an installed shop app opens and pushes as the shop; only when the shop's frame
 * rendered (`data-shop-frame`), so an unknown slug never asks for a worker that 404s (fail2ban
 * counts 4xx). A constant string (ADR 0015).
 */
export const REGISTRATION_SCRIPT = `(function(){
var m=location.pathname.match(/^\\/s\\/([a-z0-9-]{3,30})(\\/|$)/);var p=m?'/s/'+m[1]:'';
if('serviceWorker' in navigator){addEventListener('load',function(){if(m&&!document.querySelector('[data-shop-frame]'))return;navigator.serviceWorker.register(p+'/sw.js',{scope:p||'/'}).catch(function(){})})}
function changed(){dispatchEvent(new Event('${INSTALL_EVENT}'))}
addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__vdInstall=e;changed()});
addEventListener('appinstalled',function(){window.__vdInstall=null;changed()});
})();`;
