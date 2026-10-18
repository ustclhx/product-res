FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /home/pwuser
RUN npm install --ignore-scripts --no-audit --no-fund playwright@1.63.0 \
  && chown -R pwuser:pwuser /home/pwuser
USER pwuser
ENV HOME=/home/pwuser
# CA 仅导入该短命浏览器的 NSS；不改宿主信任库、不忽略证书错误。
CMD ["sh", "-c", "mkdir -p $HOME/.pki/nssdb; certutil -N --empty-password -d sql:$HOME/.pki/nssdb; certutil -A -t 'C,,' -n selfhost-c-profile -d sql:$HOME/.pki/nssdb -i /fixture/ca.crt; exec ./node_modules/.bin/playwright run-server --host 0.0.0.0 --port 3000"]
