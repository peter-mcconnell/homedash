FROM python:3.12-slim
RUN pip install --no-cache-dir "paho-mqtt>=2.0,<3" "pillow>=10,<12" "pymupdf>=1.24,<2" "segno>=1.6,<2"
WORKDIR /app
COPY server/ /app/
ENV PYTHONUNBUFFERED=1
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=4)"
CMD ["python", "app.py"]
