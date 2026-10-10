import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Last line of defence: a rendering bug must never leave the user with a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render failure', error.message, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Container maxWidth="sm" component="main" sx={{ py: 8 }}>
        <Alert
          severity="error"
          variant="outlined"
          action={<Button onClick={() => window.location.reload()}>Reload</Button>}
        >
          <AlertTitle component="h1">Something broke while showing this page</AlertTitle>
          Reloading usually fixes it. Your recent summaries are still saved in this browser.
        </Alert>
      </Container>
    );
  }
}
