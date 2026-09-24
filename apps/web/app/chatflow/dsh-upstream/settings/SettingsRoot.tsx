// DSH settings panel source; Allrice supplies section slots and the published Modal.
import { useEffect, useId, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Modal,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconCloseOutlineRegular, IconDataOutlineMedium,
  IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SettingsRoot.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}

export type SettingsSlotRenderer = (name: 'settings.header' | 'settings.action' | 'settings.close' | 'settings.section', props: { close?: () => void }, options?: { only: string }) => ReactNode

type PanelProps = {
  rows: readonly { id: string; label: string }[]
  renderSlot: SettingsSlotRenderer
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
export function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = closeButton.current?.closest('[role="dialog"]')
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return
      const nodes = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length > 0)
      const first = nodes[0], last = nodes.at(-1)
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first?.focus()
      }
    }
    document.addEventListener('keydown', trap)
    return () => {
      document.removeEventListener('keydown', trap)
      document.body.style.overflow = overflow
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  return (
    <Modal open headless title="设置" onClose={onClose} className={css.panel}
      onKeyDownCapture={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      }}
    >
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutlineRegular size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
    </Modal>
  )
}
