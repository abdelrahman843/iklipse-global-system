// -----------------------------------------------------------------------------
// Parts of the app switched on or off in one place.
// -----------------------------------------------------------------------------

/**
 * Zoom is off for now (0084): Calendly took its place in the sidebar, on the
 * Connected accounts page and in the WhatsApp bot. Its code, tables and
 * function stay. true brings its page and tab back; the bot books on Zoom
 * again with watch_settings.book_with = 'zoom'.
 */
export const ZOOM_ON = false;
