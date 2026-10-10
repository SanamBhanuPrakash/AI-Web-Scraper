import ArrowForwardIcon from '@mui/icons-material/ArrowForwardRounded';
import CheckIcon from '@mui/icons-material/CheckRounded';
import CloseIcon from '@mui/icons-material/CloseRounded';
import LinkIcon from '@mui/icons-material/LinkRounded';
import PasteIcon from '@mui/icons-material/ContentPasteRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useRef, type FormEvent, type RefObject } from 'react';
import type { Format, Length } from '../lib/api';
import { LANGUAGES } from '../lib/languages';

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** One line under the control, linked to it for screen readers. */
  hint?: string | undefined;
}

/** Material 3 segmented control: exclusive toggle buttons; the selected one shows a check mark. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: SegmentedProps<T>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <Box>
      <Typography id={id} variant="subtitle2" sx={{ mb: 1 }}>
        {label}
      </Typography>
      <ToggleButtonGroup
        exclusive
        value={value}
        disabled={disabled}
        aria-labelledby={id}
        {...(hint ? { 'aria-describedby': hintId } : {})}
        onChange={(_, next: T | null) => next && onChange(next)}
      >
        {options.map((o) => (
          <ToggleButton key={o.value} value={o.value}>
            {value === o.value && <CheckIcon fontSize="small" sx={{ mr: 0.75, ml: -0.5 }} />}
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {hint && (
        <Typography
          id={hintId}
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: 0.75, maxWidth: '40ch' }}
        >
          {hint}
        </Typography>
      )}
    </Box>
  );
}

const LENGTHS = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long' },
] as const;
const DEPTHS = [
  { value: 'quick', label: 'Quick' },
  { value: 'detailed', label: 'Detailed' },
] as const;
const FORMATS = [
  { value: 'bullets', label: 'Bullets' },
  { value: 'paragraph', label: 'Paragraph' },
] as const;

export interface UrlFormProps {
  value: string;
  onValue: (v: string) => void;
  length: Length;
  onLength: (v: Length) => void;
  format: Format;
  onFormat: (v: Format) => void;
  language: string;
  onLanguage: (v: string) => void;
  working: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function UrlForm(p: UrlFormProps) {
  // Depth is the first choice: Detailed (read the whole page, then write a structured brief) or Quick (one pass,
  // with a length and a format). Switching back to Quick restores the length the person last used.
  const deep = p.length === 'detailed';
  const lastQuick = useRef<Exclude<Length, 'detailed'>>('medium');
  useEffect(() => {
    if (p.length !== 'detailed') lastQuick.current = p.length;
  }, [p.length]);

  // The Summarize button turns into Cancel in place. A double click or double tap on Summarize must not
  // land its second click on Cancel, so clicks right after the switch are ignored.
  const workingSince = useRef(0);
  useEffect(() => {
    workingSince.current = p.working ? Date.now() : 0;
  }, [p.working]);
  const cancelClick = () => {
    if (Date.now() - workingSince.current < 450) return;
    p.onCancel();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (p.working) return;
    p.onSubmit();
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) p.onValue(text.trim());
    } catch {
      /* permission denied or unsupported: the field simply stays as it was */
    }
    p.inputRef.current?.focus();
  };

  return (
    <Stack component="form" onSubmit={submit} noValidate spacing={3} sx={{ mt: 4 }}>
      <TextField
        inputRef={p.inputRef}
        id="page-address"
        label="Page address"
        placeholder="https://example.com/article"
        value={p.value}
        onChange={(e) => p.onValue(e.target.value)}
        error={!!p.error}
        helperText={p.error ?? 'Press / to jump here from anywhere.'}
        fullWidth
        slotProps={{
          inputLabel: { shrink: true },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <LinkIcon />
              </InputAdornment>
            ),
            endAdornment: (
              <InputAdornment position="end">
                {p.value ? (
                  <Tooltip title="Clear">
                    <IconButton
                      edge="end"
                      aria-label="Clear address"
                      onClick={() => {
                        p.onValue('');
                        p.inputRef.current?.focus();
                      }}
                    >
                      <CloseIcon />
                    </IconButton>
                  </Tooltip>
                ) : (
                  <Tooltip title="Paste from clipboard">
                    <IconButton
                      edge="end"
                      aria-label="Paste from clipboard"
                      onClick={pasteFromClipboard}
                    >
                      <PasteIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </InputAdornment>
            ),
          },
          htmlInput: {
            inputMode: 'url',
            autoComplete: 'off',
            autoCapitalize: 'off',
            autoCorrect: 'off',
            spellCheck: false,
          },
          formHelperText: p.error
            ? { role: 'alert', className: 'field-error' }
            : { className: 'field-hint' },
        }}
      />

      <Segmented
        label="Depth"
        value={deep ? 'detailed' : 'quick'}
        options={DEPTHS}
        onChange={(v) => p.onLength(v === 'detailed' ? 'detailed' : lastQuick.current)}
        disabled={p.working}
        hint={
          deep
            ? 'Reads the whole page, checks every claim, then writes a structured brief. 10 to 20 seconds.'
            : 'One fast pass. About 2 seconds.'
        }
      />

      <Collapse in={!deep} unmountOnExit timeout={240}>
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 3 }}>
          <Segmented
            label="Length"
            value={deep ? lastQuick.current : p.length}
            options={LENGTHS}
            onChange={p.onLength}
            disabled={p.working}
          />
          <Segmented
            label="Format"
            value={p.format}
            options={FORMATS}
            onChange={p.onFormat}
            disabled={p.working}
          />
        </Stack>
      </Collapse>

      <TextField
        select
        id="summary-language"
        label="Summary language"
        value={p.language}
        onChange={(e) => p.onLanguage(e.target.value)}
        disabled={p.working}
        fullWidth
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      >
        {LANGUAGES.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </TextField>

      {/* One persistent button: it keeps keyboard focus when it turns into Cancel. */}
      <Button
        type={p.working ? 'button' : 'submit'}
        variant={p.working ? 'outlined' : 'contained'}
        size="large"
        fullWidth
        onClick={p.working ? cancelClick : undefined}
        endIcon={p.working ? undefined : <ArrowForwardIcon />}
      >
        {p.working ? 'Cancel' : 'Summarize'}
      </Button>
    </Stack>
  );
}
