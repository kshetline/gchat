import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = localStorage.getItem('chat-token');

  if (token && !req.url.endsWith('/api/token'))
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });

  return next(req);
};
