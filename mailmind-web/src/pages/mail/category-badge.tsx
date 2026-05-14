import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { LuChevronDown, LuLoader } from 'react-icons/lu';

type Tone = {
  bg: string;
  fg: string;
  border: string;
};

const CATEGORY_TONES: Record<string, Tone> = {
  'İş/Acil':  { bg: 'rgba(239, 68, 68, 0.16)',  fg: '#fca5a5', border: 'rgba(239, 68, 68, 0.45)' },
  'Kişisel':  { bg: 'rgba(236, 72, 153, 0.16)', fg: '#f9a8d4', border: 'rgba(236, 72, 153, 0.45)' },
  'Bildirim': { bg: 'rgba(59, 130, 246, 0.18)', fg: '#93c5fd', border: 'rgba(59, 130, 246, 0.45)' },
  'Güvenlik': { bg: 'rgba(245, 158, 11, 0.18)', fg: '#fcd34d', border: 'rgba(245, 158, 11, 0.5)' },
  'Spam':     { bg: 'rgba(120, 113, 108, 0.22)', fg: '#d6d3d1', border: 'rgba(120, 113, 108, 0.5)' },
  'Diğer':    { bg: 'rgba(148, 163, 184, 0.18)', fg: '#cbd5e1', border: 'rgba(148, 163, 184, 0.45)' },
};

const DEFAULT_TONE: Tone = CATEGORY_TONES['Diğer'];

// Eski 10-sınıflık DB değerlerini yeni 6-sınıflık etikete eşle.
// Backfill yapılmamış kayıtlar UI'da yeni renklerle görünür; backfill SQL'i
// çalıştığında bu mapping atıl kalır ama güvenlik ağı olarak kalmasında zarar yok.
const LEGACY_LABEL_REMAP: Record<string, string> = {
  'Güvenlik/Uyarı': 'Güvenlik',
  'Pazarlama': 'Bildirim',
  'Sosyal Medya': 'Bildirim',
  'Abonelik/Fatura': 'Bildirim',
  'Eğitim/Öğretim': 'Diğer',
  'Sağlık': 'Diğer',
};

export function normalizeCategory(label: string | null | undefined): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  return LEGACY_LABEL_REMAP[trimmed] ?? trimmed;
}

export const CATEGORY_LIST: ReadonlyArray<keyof typeof CATEGORY_TONES> = [
  'İş/Acil',
  'Kişisel',
  'Bildirim',
  'Güvenlik',
  'Spam',
  'Diğer',
];

function toneStyle(tone: Tone): CSSProperties {
  return {
    background: tone.bg,
    color: tone.fg,
    border: `1px solid ${tone.border}`,
  };
}

type Props = {
  category: string | null | undefined;
  confidence?: number | null;
  className?: string;
  /** Verilirse rozet tıklanabilir hale gelir, kategori seçici açılır. */
  onChange?: (next: string) => Promise<void> | void;
};

export function CategoryBadge({ category: rawCategory, confidence, className, onChange }: Props) {
  const category = normalizeCategory(rawCategory);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

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

  if (!category || !category.trim()) {
    if (!onChange) return null;
    // Kategorisiz mailler için: sadece "Kategori belirle" butonu göster.
    return (
      <span className="mail-category-badge-wrap" ref={wrapperRef}>
        <button
          type="button"
          className="mail-category-badge mail-category-badge--empty"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          Kategori belirle <LuChevronDown size={11} aria-hidden />
        </button>
        {open ? renderMenu({ active: null, pending, onPick: handlePick }) : null}
      </span>
    );
  }

  const tone = CATEGORY_TONES[category] ?? DEFAULT_TONE;
  const pct =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.round(confidence * 100)
      : null;
  const title = pct != null ? `${category} (%${pct} güven)` : category;
  const cls = className ?? 'mail-category-badge';

  if (!onChange) {
    return (
      <span className={cls} style={toneStyle(tone)} title={title}>
        {category}
      </span>
    );
  }

  // Editable: button + chevron + menu
  return (
    <span className="mail-category-badge-wrap" ref={wrapperRef}>
      <button
        type="button"
        className={`${cls} mail-category-badge--editable`}
        style={toneStyle(tone)}
        title={`${title} — değiştirmek için tıkla`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={pending !== null}
      >
        {pending ? (
          <LuLoader size={11} className="mail-category-badge__spinner" aria-hidden />
        ) : null}
        <span>{pending ?? category}</span>
        <LuChevronDown size={11} aria-hidden style={{ marginLeft: 4, opacity: 0.7 }} />
      </button>
      {open ? renderMenu({ active: category, pending, onPick: handlePick }) : null}
    </span>
  );

  async function handlePick(next: string) {
    if (!onChange || pending || next === category) {
      setOpen(false);
      return;
    }
    setPending(next);
    try {
      await onChange(next);
    } finally {
      setPending(null);
      setOpen(false);
    }
  }
}

function renderMenu(args: {
  active: string | null;
  pending: string | null;
  onPick: (next: string) => void;
}) {
  const { active, pending, onPick } = args;
  return (
    <div
      className="mail-category-menu"
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mail-category-menu__head">Kategori</div>
      <ul className="mail-category-menu__list">
        {CATEGORY_LIST.map((c) => {
          const tone = CATEGORY_TONES[c] ?? DEFAULT_TONE;
          const isActive = c === active;
          return (
            <li key={c}>
              <button
                type="button"
                role="menuitem"
                className={
                  'mail-category-menu__item' +
                  (isActive ? ' mail-category-menu__item--active' : '')
                }
                onClick={() => onPick(c)}
                disabled={pending !== null}
              >
                <span
                  className="mail-category-menu__swatch"
                  style={{ background: tone.bg, border: `1px solid ${tone.border}` }}
                  aria-hidden
                />
                <span className="mail-category-menu__label" style={{ color: tone.fg }}>
                  {c}
                </span>
                {isActive ? <span className="mail-category-menu__check" aria-hidden>✓</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
