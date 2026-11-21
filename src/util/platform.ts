/** WebKitGTK names Linux in the user agent; the macOS build says Macintosh. Presentation
 * only: on Linux the window manager draws the window buttons, so the app does not. */
export const ON_LINUX =
  /\bLinux\b/.test(navigator.userAgent) && !/\bAndroid\b/.test(navigator.userAgent);
