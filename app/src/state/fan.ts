/**
 * Fan spinner timing.
 *
 * A real fan at 2700 RPM turns 45 times a second. Animating that literally
 * would be a blur at best and, against a 60Hz display, a wheel that appears to
 * stand still or run backwards. So the spinner is a gauge rather than a
 * replica: it turns visibly faster as the fan does, over a range the eye can
 * actually follow.
 */

/** Below this the fan is treated as stopped rather than very slow. */
export const FAN_STOPPED_RPM = 100;

/** Fastest and slowest the spinner is allowed to turn, in seconds per turn. */
export const FAN_MIN_SECONDS = 0.28;
export const FAN_MAX_SECONDS = 3.2;

/** RPM that maps to the fastest spin. Above this it is pinned. */
export const FAN_FULL_RPM = 5000;

/**
 * Seconds per revolution for a given fan speed, or null when it is stopped.
 *
 * Null rather than a very long duration because a stopped fan and a crawling
 * one should not look the same: the caller stops the animation outright.
 */
export function fanSpinSeconds(rpm: number | null | undefined): number | null {
  if (rpm === null || rpm === undefined || !Number.isFinite(rpm)) return null;
  if (rpm < FAN_STOPPED_RPM) return null;

  // Linear in RPM, which keeps the change legible across the whole range: a
  // curve makes the middle of the dial barely move while the top end does all
  // the work, and the middle is where a laptop fan actually lives.
  const t = Math.min(1, rpm / FAN_FULL_RPM);
  const seconds = FAN_MAX_SECONDS - t * (FAN_MAX_SECONDS - FAN_MIN_SECONDS);
  return Math.round(seconds * 1000) / 1000;
}
