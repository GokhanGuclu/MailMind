import { useEffect, useRef, useState } from 'react';
import { LuChevronDown, LuFilter } from 'react-icons/lu';
import { CATEGORY_LIST } from './category-badge';

type Tone = { bg: string; border: string };

const CATEGORY_TONES: Record<string, Tone> = {
  'İş/Acil':  { bg: 'rgba(239, 68, 68, 0.16)',  border: 'rgba(239, 68, 68, 0.45)' },
  'Kişisel':  { bg: 'rgba(236, 72, 153, 0.16)', border: 'rgba(236, 72, 153, 0.45)' },
  'Bildirim': { bg: 'rgba(59, 130, 246, 0.18)', border: 'rgba(59, 130, 246, 0.45)' },
  'Güvenlik': { bg: 'rgba(245, 158, 11, 0.18)', border: 'rgba(245, 158, 11, 0.5)' },
  'Spam':     { bg: 'rgba(120, 113, 108, 0.22)', border: 'rgba(120, 113, 108, 0.5)' },
  'Diğer':    { bg: 'rgba(148, 163, 184, 0.18)', border: 'rgba(148, 163, 184, 0.45)' },
};

type Props = {
  /** Boş set = "Tümü" (filtre yok). */
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  language: 'tr' | 'en';
};

export function CategoryFilterDropdown({ value, onChange, language }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const allLabel = language === 'tr' ? 'Tümü' : 'All';
  const buttonTitle =
    language === 'tr' ? 'Kategoriye göre filtrele' : 'Filter by category';

  const triggerLabel =
    value.size === 0
      ? allLabel
      : value.size === 1
        ? Array.from(value)[0]
        : language === 'tr'
          ? `${value.size} kategori`
          : `${value.size} categories`;

  const toggle = (c: string) => {
    const next = new Set(value);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    onChange(next);
  };

  const clearAll = () => onChange(new Set());

  return (
    <div className="mail-inbox-toolbar__cat-filter" ref={wrapperRef}>
      <button
        type="button"
        className={
          'mail-inbox-toolbar__cat-filter-btn' +
          (value.size > 0 ? ' mail-inbox-toolbar__cat-filter-btn--active' : '')
        }
        title={buttonTitle}
        onClick={() => setOpen((v) => !v)}
      >
        <LuFilter size={13} aria-hidden />
        <span>{triggerLabel}</span>
        <LuChevronDown size={12} aria-hidden style={{ opacity: 0.7 }} />
      </button>
      {open ? (
        <div className="mail-category-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <div className="mail-category-menu__head">{buttonTitle}</div>
          <ul className="mail-category-menu__list">
            <li>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value.size === 0}
                className={
                  'mail-category-menu__item' +
                  (value.size === 0 ? ' mail-category-menu__item--active' : '')
                }
                onClick={clearAll}
              >
                <span
                  className="mail-category-menu__swatch"
                  style={{
                    background: 'transparent',
                    border: '1px dashed currentColor',
                    opacity: 0.6,
                  }}
                  aria-hidden
                />
                <span className="mail-category-menu__label">{allLabel}</span>
                {value.size === 0 ? (
                  <span className="mail-category-menu__check" aria-hidden>
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
            {CATEGORY_LIST.map((c) => {
              const tone = CATEGORY_TONES[c];
              const isActive = value.has(c);
              return (
                <li key={c}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={isActive}
                    className={
                      'mail-category-menu__item' +
                      (isActive ? ' mail-category-menu__item--active' : '')
                    }
                    onClick={() => toggle(c)}
                  >
                    <span
                      className="mail-category-menu__swatch"
                      style={{ background: tone.bg, border: `1px solid ${tone.border}` }}
                      aria-hidden
                    />
                    <span className="mail-category-menu__label">{c}</span>
                    {isActive ? (
                      <span className="mail-category-menu__check" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
