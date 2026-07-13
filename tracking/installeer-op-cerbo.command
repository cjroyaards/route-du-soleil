#!/bin/bash
# Installeert de signalk-github-tracker plugin op de Cerbo GX (venus.local)
# Dubbelklik dit bestand; voer één keer het root-wachtwoord van de Cerbo in.

cd "$(dirname "$0")" || exit 1

echo "Plugin kopiëren naar de Cerbo en Signal K herstarten..."
echo "(wachtwoord = het root-wachtwoord dat je op de Cerbo hebt ingesteld)"
echo

tar -cf - signalk-github-tracker | ssh root@venus.local '
  mkdir -p /data/conf/signalk/node_modules &&
  tar -xf - -C /data/conf/signalk/node_modules &&
  { svc -t /service/signalk-server 2>/dev/null || svc -t /service/signalk 2>/dev/null || echo "(Signal K-service niet gevonden — herstart de Cerbo via de Remote Console)"; } &&
  echo &&
  echo "KLAAR — plugin geinstalleerd, Signal K herstart."
'

if [ $? -ne 0 ]; then
  echo
  echo "MISLUKT. Checklist:"
  echo "- Zit deze Mac op hetzelfde netwerk als de Cerbo?"
  echo "- Is SSH aan? (Cerbo: Settings > General > SSH on LAN + root password)"
  echo "- Werkt venus.local niet? Vervang het in dit bestand door het IP-adres"
  echo "  van de Cerbo (Settings > Ethernet/WiFi op de Remote Console)."
fi
echo
read -p "Druk op Enter om dit venster te sluiten..."
