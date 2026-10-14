// Video Library's motion, shared: one soft ease-out curve, short travel.
export const EASE = [0.22, 1, 0.36, 1] as const;
/** The sliding "you are here" pill (sidebar, tabs, segmented controls). */
export const SLIDE = { duration: 0.25, ease: EASE };
/** Switch knobs. */
export const SPRING = { type: "spring", stiffness: 500, damping: 34 } as const;
