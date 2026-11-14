import type { ButtonHTMLAttributes, ReactNode } from 'react'
import css from './studio-actions.module.css'

/** Shared action chrome for the studio, reference tools and prompt dialog. */
export function StudioActionButton({ icon, variant = 'secondary', className, children, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode
  variant?: 'primary' | 'secondary' | 'quiet'
}): React.JSX.Element {
  return <button {...props} type={type} className={`${css.action} ${css[variant]}${className ? ` ${className}` : ''}`}>
    {icon ? <span className={css.icon} aria-hidden="true">{icon}</span> : null}
    <span className={css.label}>{children}</span>
  </button>
}
