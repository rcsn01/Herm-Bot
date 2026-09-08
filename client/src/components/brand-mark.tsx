export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <div aria-hidden="true" className={small ? 'brand-mark small' : 'brand-mark'}>
      <img alt="" src="/icons/icon-192.png" />
    </div>
  )
}
