export interface SelectOption {
  label: string
  value: string
}

/** Keep an out-of-catalog value selectable so an existing custom provider or
 *  model renders instead of vanishing from a closed <select>. */
export function ensureOption(options: readonly SelectOption[], value: string): SelectOption[] {
  return value && !options.some(option => option.value === value) ? [{ label: value, value }, ...options] : [...options]
}

interface ModelSelectProps {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  onChange(next: string): void
  options: readonly SelectOption[]
  placeholder: string
  value: string
}

/** Full-width native select — iOS renders these as native pickers, which is
 *  the right mobile affordance for provider/model catalogs. */
export function ModelSelect({ ariaLabel, className, disabled, onChange, options, placeholder, value }: ModelSelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      className={className ? `models-select ${className}` : 'models-select'}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      value={value}
    >
      <option value="">{placeholder}</option>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

export const providerOptions = (providers: readonly { name?: string; slug: string }[]): SelectOption[] =>
  providers.filter(provider => provider.slug).map(provider => ({ label: provider.name || provider.slug, value: provider.slug }))

export const modelOptions = (models: readonly string[]): SelectOption[] => models.map(model => ({ label: model, value: model }))