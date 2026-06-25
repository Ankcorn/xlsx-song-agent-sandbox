FROM docker.io/cloudflare/sandbox:0.12.1-python

RUN pip3 install --no-cache-dir openpyxl odfpy lxml

EXPOSE 8080
