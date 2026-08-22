import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Compatibility target for the stable desktop primitives' sole app alias. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
