import { useLayoutEffect, type RefObject } from 'react';
import styles from './dsh-saas.module.css';

/** Use the avatar's existing CSS animation clock, including for later steps. */
export function useWorkProcessPulse(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const message = root.current?.closest('[data-working="true"]');
    const avatar = message?.querySelector(`.${styles.assistantIdentity} i`);
    const clock = avatar?.getAnimations()[0];
    if (!clock || !(clock instanceof CSSAnimation)) return;
    const pulses = message!
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === clock.animationName,
      );
    let live = true;
    void Promise.all(pulses.map((animation) => animation.ready))
      .then(() => {
        if (!live || clock.startTime === null) return;
        for (const animation of pulses) animation.startTime = clock.startTime;
      })
      .catch((error: unknown) => {
        // Reduced motion, completion or unmount can cancel a pending animation.
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          throw error;
      });
    return () => {
      live = false;
    };
  });
}
