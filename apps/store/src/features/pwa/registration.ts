/** Dispatched on `window` when installing becomes possible or stops being so (install.ts). */
export const INSTALL_EVENT = 'vd-install';

/**
 * SW2 and IN1, inline in the layout's head so no bundle JS joins any page's first load: registers
 * `/sw.js` after `load` where service workers exist, and keeps Chromium's `beforeinstallprompt`
 * on `window.__vdInstall` (no mini-infobar: "ثبّت التطبيق" offers it) until `appinstalled`.
 * A constant string (ADR 0015).
 */
export const REGISTRATION_SCRIPT = `(function(){
if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(function(){})})}
function changed(){dispatchEvent(new Event('${INSTALL_EVENT}'))}
addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__vdInstall=e;changed()});
addEventListener('appinstalled',function(){window.__vdInstall=null;changed()});
})();`;
