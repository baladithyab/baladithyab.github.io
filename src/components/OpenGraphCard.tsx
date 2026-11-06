interface OpenGraphCardProps {
  title: string
  subtitle: string
  description: string
  accent: string
  tag: string
}

export default function OpenGraphCard({
  title,
  subtitle,
  description,
  accent,
  tag,
}: OpenGraphCardProps) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'linear-gradient(135deg, #0b0f17 0%, #111827 60%, #0b0f17 100%)',
        color: '#f8fafc',
        fontFamily: 'sans-serif',
        padding: '64px 80px',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 28, color: '#94a3b8' }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: accent,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#0b0f17',
            fontWeight: 700,
            fontSize: 22,
          }}
        >
          {'{#}'}
        </div>
        <span>{subtitle}</span>
      </div>
      {tag && (
        <div
          style={{
            position: 'absolute', top: 64, right: 80, padding: '8px 18px', borderRadius: 999,
            border: `2px solid ${accent}`, color: accent, fontSize: 22, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 2, display: 'flex',
          }}
        >
          {tag}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex' }} />
      <div
        style={{
          display: 'flex', fontSize: 76, fontWeight: 700, lineHeight: 1.05,
          letterSpacing: '-0.02em', maxWidth: '100%',
        }}
      >
        {title}
      </div>
      {description && (
        <div
          style={{
            display: 'flex', marginTop: 28, fontSize: 30, color: '#cbd5e1', lineHeight: 1.4,
            maxWidth: 1000,
          }}
        >
          {description}
        </div>
      )}
      <div style={{ flex: 1, display: 'flex' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 26, color: '#94a3b8' }}>
        <div style={{ width: 56, height: 6, borderRadius: 3, background: accent, display: 'flex' }} />
        <span>codeseys.io</span>
      </div>
    </div>
  )
}
