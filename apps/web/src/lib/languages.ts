/** Summary languages offered in the UI (BCP-47 tags the API accepts). An empty value means "same as the page". */
export const LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Same as the page' },
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi (हिन्दी)' },
  { value: 'es', label: 'Spanish (Español)' },
  { value: 'fr', label: 'French (Français)' },
  { value: 'de', label: 'German (Deutsch)' },
  { value: 'pt', label: 'Portuguese (Português)' },
  { value: 'it', label: 'Italian (Italiano)' },
  { value: 'ja', label: 'Japanese (日本語)' },
  { value: 'ko', label: 'Korean (한국어)' },
  { value: 'zh', label: 'Chinese (中文)' },
  { value: 'ar', label: 'Arabic (العربية)' },
  { value: 'ru', label: 'Russian (Русский)' },
  { value: 'id', label: 'Indonesian' },
  { value: 'tr', label: 'Turkish (Türkçe)' },
];

export const LANGUAGE_VALUES: ReadonlySet<string> = new Set(LANGUAGES.map((l) => l.value));
