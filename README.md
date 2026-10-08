# foûfoûni-Market — mise en service des paiements réels

Ce dossier contient la boutique complète (boutique en ligne, caisse, gestion) et un serveur Node.js qui encaisse pour de vrai avec **Wave** et **Orange Money**. Le paiement à la livraison reste disponible.

## 1. Ce qu'il faut obtenir avant de commencer

**Wave**
1. Un compte **Wave Business** au nom de la boutique.
2. L'accès à l'API Checkout. Si la section « Développeurs » n'apparaît pas dans le portail Wave Business, demandez son activation au support Wave (seuls les administrateurs y ont accès).
3. Dans *Développeurs › Clés API* : créez une clé avec l'API **Checkout** cochée. Activez la signature des requêtes et notez le *signing secret* (il ne s'affiche qu'une fois).
4. Dans *Développeurs › Webhooks* : ajoutez l'adresse `https://VOTRE-DOMAINE/webhooks/wave`, stratégie **Signing secret**, événements `checkout.session.completed` et `checkout.session.payment_failed`. Notez le secret du webhook.

**Orange Money**
1. Un statut de **marchand Orange Money** : l'inscription se fait en agence Orange Mali, avec les documents de l'entreprise.
2. Un compte sur developer.orange.com, puis un abonnement à l'API **Orange Money Web Payment**.
3. Récupérez l'**en-tête d'autorisation** (`Basic …`) et la **merchant key**.
4. Testez d'abord dans le bac à sable (devise `OUV`), puis demandez à Orange l'URL et les accès de production pour le Mali (devise `XOF`).

## 2. Hébergement

Il faut un serveur accessible en **HTTPS** avec un nom de domaine : Wave et Orange refusent d'envoyer leurs confirmations vers une adresse non sécurisée.

Options simples : un petit VPS (avec Nginx + Let's Encrypt), Render, Railway ou Fly.io. Prévoyez un **disque persistant** pour le fichier `data.sqlite` qui contient produits, commandes et comptes.

## 3. Installation

```bash
npm install
cp .env.example .env
# Remplissez .env (voir ci-dessous)
npm start
```

Node.js 18.18 ou plus récent est requis.

| Variable | Rôle |
|---|---|
| `BASE_URL` | Adresse publique HTTPS de la boutique |
| `SESSION_SECRET` | Chaîne aléatoire de 32 caractères ou plus (`openssl rand -hex 32`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Premier compte gérant, créé au premier démarrage |
| `WAVE_API_KEY`, `WAVE_SIGNING_SECRET`, `WAVE_WEBHOOK_SECRET` | Clés Wave |
| `OM_AUTH_HEADER`, `OM_MERCHANT_KEY`, `OM_API_BASE`, `OM_CURRENCY` | Accès Orange Money |

Un moyen de paiement dont les clés sont absentes est simplement masqué aux clients. Vous pouvez donc lancer avec Wave seul, puis ajouter Orange Money plus tard.

## 4. Fonctionnement d'un paiement

1. Le client valide son panier. **Le serveur recalcule les prix, la remise et les frais de livraison** : le navigateur ne décide jamais du montant.
2. Le serveur crée la session de paiement chez Wave ou Orange, puis le client y est redirigé.
3. Après le paiement, le client revient sur la boutique. La page attend la confirmation du serveur.
4. La commande passe en **Payée** uniquement quand le serveur a reçu la confirmation :
   - pour Wave, par le webhook signé, dont la signature, l'horodatage et le montant sont vérifiés ;
   - pour Orange, par la notification, toujours **revérifiée** auprès d'Orange avant validation.
5. Le stock est déduit à ce moment-là, une seule fois, même si la confirmation arrive en double.

Toutes les 5 minutes, le serveur revérifie aussi les paiements restés en attente depuis moins de 24 h, au cas où une notification se serait perdue.

## 5. Avant d'ouvrir au public

- Faites un vrai paiement Wave de 100 FCFA, vérifiez qu'il passe en « Payée », puis remboursez-le depuis la fiche de la commande (bouton réservé au gérant).
- Testez Orange Money dans le bac à sable dans trois cas : paiement réussi, paiement annulé et délai dépassé.
- Dans le portail Wave, utilisez le bouton de test du webhook et vérifiez dans les journaux du serveur qu'il est bien reçu.
- Sauvegardez `data.sqlite` régulièrement.

## 6. Équipe

Connectez-vous via « Espace équipe » en haut de la boutique. Le gérant crée les comptes (Vendeur, Caissier, Livreur, Gestionnaire de stock) dans *Gestion › Équipe*. Les clients n'ont pas besoin de compte : leurs commandes restent retrouvables dans « Mes commandes » sur leur téléphone.

## Sécurité

- Ne mettez jamais le fichier `.env` en ligne, que ce soit sur GitHub ou ailleurs.
- Si une clé fuite, révoquez-la immédiatement dans le portail Wave et recréez-en une.
- Wave permet aussi de limiter l'usage de la clé à l'adresse IP de votre serveur. C'est recommandé.
