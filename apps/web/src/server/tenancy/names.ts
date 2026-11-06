/**
 * Name of a personal space: « Espace d'Ethan », « Espace de Camille » — same rule as migration
 * 0002 (elision before a vowel or an h, first word of the account name).
 */
export function personalSpaceName(accountName: string): string {
  const first = accountName.trim().split(/\s+/)[0] ?? '';
  if (!first) return 'Espace personnel';
  return /^[aeiouyhàâäéèêëîïôöùûüÿæœ]/i.test(first) ? `Espace d'${first}` : `Espace de ${first}`;
}
