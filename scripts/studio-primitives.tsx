/** Test-only host controls; the production studio itself remains unchanged. */
import type { ButtonHTMLAttributes } from 'react'
export function Button({ children, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }): React.JSX.Element { return <button type="button" {...props}>{children}</button> }
export function Pill({ active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }): React.JSX.Element { return <Button {...props} aria-pressed={active} /> }
