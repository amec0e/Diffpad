# Diffpad
Diff text based files

**Setup:**

Put `81-diffpad.conf` in `/etc/lighttpd/conf-enabled/`

Put all other files in `/var/www/html/diffpad`

**Set permissions:**

```
sudo chown -R www-data:www-data /var/www/html/diffpad
sudo chmod 755 /var/www/html/diffpad
sudo chmod 644 /var/www/html/diffpad/*
```

**Restart lighttpd:**

`sudo systemctl restart lighttpd`

accessible at `http://YOUR-IP/diffpad`

If you do not want to host locally (which can be done on a Pi 4 2GB) you can use the [online version](https://amec0e.github.io/Diffpad/)
