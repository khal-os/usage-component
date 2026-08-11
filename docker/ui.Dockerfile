# Platform UI image. Build context = workspace ROOT:
#
#   docker build -f docker/ui.Dockerfile -t platform-ui:local .
#
# Static files behind nginx, which also reverse-proxies /api to the client's
# own api service (see ui.nginx.conf). Client-agnostic like every image here:
# the same image serves any client, identity comes from the stack it runs in.

FROM nginx:1.29-alpine
COPY docker/ui.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY packages/ui/index.html packages/ui/app.js packages/ui/styles.css /usr/share/nginx/html/
