import { AllriceMark } from './allrice-mark';
import styles from './allrice-brand.module.css';

export function AllriceBrand() {
  return (
    <span className={styles.brand} role="img" aria-label="Allrice">
      <AllriceMark size={28} />
      <span className={styles.wordmark} aria-hidden="true">
        allr
        <span className={styles.i}>
          ı
          <svg viewBox="0 0 16 24" focusable="false" aria-hidden="true">
            <path d="M15 1C5 3 0 12 1 23C11 21 16 12 15 1Z" />
          </svg>
        </span>
        ce
      </span>
    </span>
  );
}
