'use client'

import { cn } from '@/lib/utils'
import { Progress } from '@/components/ui/progress'

interface MetricCardProps {
  label: string
  value: string
  subValue?: string
  percent?: number // 0-100 — if provided, shows a progress bar
  accent?: 'emerald' | 'amber' | 'rose' | 'cyan' | 'zinc'
  icon?: React.ReactNode
  footer?: React.ReactNode
}

const ACCENTS: Record<NonNullable<MetricCardProps['accent']>, { text: string; bar: string; glow: string; ring: string }> = {
  emerald: { text: 'text-emerald-400', bar: '[&>div]:bg-emerald-500', glow: 'shadow-emerald-500/20', ring: 'ring-emerald-500/30' },
  amber:   { text: 'text-amber-400',   bar: '[&>div]:bg-amber-500',   glow: 'shadow-amber-500/20',   ring: 'ring-amber-500/30' },
  rose:    { text: 'text-rose-400',    bar: '[&>div]:bg-rose-500',    glow: 'shadow-rose-500/20',    ring: 'ring-rose-500/30' },
  cyan:    { text: 'text-cyan-400',    bar: '[&>div]:bg-cyan-500',    glow: 'shadow-cyan-500/20',    ring: 'ring-cyan-500/30' },
  zinc:    { text: 'text-zinc-300',    bar: '[&>div]:bg-zinc-500',    glow: 'shadow-zinc-500/10',    ring: 'ring-zinc-500/20' },
}

export function MetricCard({ label, value, subValue, percent, accent = 'zinc', icon, footer }: MetricCardProps) {
  const a = ACCENTS[accent]
  return (
    <div
      className={cn(
        'rounded-xl border border-zinc-800 bg-zinc-900/60 backdrop-blur p-4 ring-1 ring-inset transition-all',
        a.ring, a.glow,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</span>
        {icon && <span className={cn('opacity-80', a.text)}>{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold tabular-nums text-zinc-100">{value}</span>
        {subValue && <span className="text-xs text-zinc-500">{subValue}</span>}
      </div>
      {typeof percent === 'number' && (
        <Progress
          value={Math.max(0, Math.min(100, percent))}
          className={cn('mt-3 h-1.5 bg-zinc-800', a.bar)}
        />
      )}
      {footer && <div className="mt-3 text-xs text-zinc-500">{footer}</div>}
    </div>
  )
}
