# The backup one-shot (decision 140): mongodump the tenant's usage store,
# stream it gzipped to S3, exit non-zero on ANY failure (the EventBridge
# rule turns that into an alert — a backup that fails silently is worse
# than none).
FROM debian:12-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
  && curl -fsSL https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-100.15.0.deb \
       -o /tmp/tools.deb \
  && apt-get install -y /tmp/tools.deb \
  && curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/aws.zip \
  && unzip -q /tmp/aws.zip -d /tmp \
  && /tmp/aws/install \
  && apt-get purge -y unzip \
  && rm -rf /tmp/* /var/lib/apt/lists/*

COPY docker/usage-db-backup-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
