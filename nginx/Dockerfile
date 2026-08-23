FROM nginx:latest

COPY nginx.conf /etc/nginx/nginx.conf
COPY proxy-common.conf /etc/nginx/proxy-common.conf
COPY html /usr/share/nginx/html
RUN chmod 755 /usr/share/nginx/html /usr/share/nginx/html/__security /usr/share/nginx/html/__security/assets \
    && chmod 644 /usr/share/nginx/html/__security/denied.html /usr/share/nginx/html/__security/assets/deep-space-checkpoint.png

EXPOSE 42981
