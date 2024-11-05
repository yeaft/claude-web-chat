FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY . /app/
ENV FLASK_RUN_HOST=0.0.0.0
EXPOSE 8080
CMD ["python", "app.py"]

