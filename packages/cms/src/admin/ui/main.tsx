import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/ui/tooltip';
// NOTE: app.css is NOT imported here — scripts/build-admin.mjs compiles it
// separately with the Tailwind CLI and serves it as /admin/assets/admin.css.
import App from './App';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <App />
        <Toaster position="bottom-right" closeButton richColors theme="system" />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
