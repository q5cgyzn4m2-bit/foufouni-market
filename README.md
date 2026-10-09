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

## 2. Hébergement gratuit : Render + Supabase

- **Supabase** garde toutes les données (produits, commandes, trésorerie, clients, comptes équipe).
- **Render** (offre gratuite) fait tourner la boutique. Le service s'endort après 15 minutes sans visite ; la première visite suivante prend quelques secondes.

### Supabase
1. Créez un compte sur supabase.com puis **New project**. Choisissez la région **Frankfurt (eu-central-1)** et notez le mot de passe de la base.
2. En haut de la page du projet, cliquez sur **Connect**, puis choisissez **Session pooler**.
3. Copiez la chaîne de connexion avec le bouton de copie et remplacez `[YOUR-PASSWORD]` par votre mot de passe.

Les tables `ffm_docs`, `ffm_users` et `ffm_events` sont créées automatiquement au premier démarrage, avec l'accès public bloqué.

### Render
1. Envoyez ces fichiers sur GitHub (dossier `public` compris), avec `render.yaml` à la racine.
2. Sur Render : **New › Blueprint**, choisissez le dépôt.
3. Remplissez `DATABASE_URL` (la chaîne Supabase), `ADMIN_EMAIL` et `ADMIN_PASSWORD`, puis **Deploy Blueprint**.

## 3. Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Chaîne « Session pooler » de Supabase |
| `SESSION_SECRET` | Générée automatiquement par Render |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Premier compte gérant, créé au premier démarrage |
| `BASE_URL` | Facultatif sur Render (détectée automatiquement), à remplir si vous utilisez votre propre domaine |
| `WAVE_API_KEY`, `WAVE_SIGNING_SECRET`, `WAVE_WEBHOOK_SECRET` | Clés Wave |
| `OM_AUTH_HEADER`, `OM_MERCHANT_KEY`, `OM_API_BASE`, `OM_CURRENCY` | Accès Orange Money |

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
- Supabase sauvegarde la base ; vous pouvez aussi exporter les tables depuis son tableau de bord.

## 6. Équipe

Connectez-vous via « Espace équipe » en haut de la boutique. Le gérant crée les comptes (Vendeur, Caissier, Livreur, Gestionnaire de stock) dans *Gestion › Équipe*. Les clients n'ont pas besoin de compte : leurs commandes restent retrouvables dans « Mes commandes » sur leur téléphone.

## Sécurité

- Ne mettez jamais le fichier `.env` en ligne, que ce soit sur GitHub ou ailleurs.
- Si une clé fuite, révoquez-la immédiatement dans le portail Wave et recréez-en une.
- Wave permet aussi de limiter l'usage de la clé à l'adresse IP de votre serveur. C'est recommandé.


## Notifications sur téléphone (ntfy)

Vous recevez une notification pour : chaque paiement Wave ou Orange Money confirmé, chaque nouvelle commande à la livraison, chaque vente en caisse (avec acompte et reste à crédit), chaque règlement client, et chaque panier abandonné.

1. Installez l'application gratuite **ntfy** (Play Store ou App Store).
2. Touchez **+**, puis inventez un nom de sujet difficile à deviner, par exemple `foufouni-k7m3q9-alertes`, et abonnez-vous.
3. Sur Render, dans **Environment**, ajoutez `NTFY_TOPIC` avec exactement ce nom.
4. Dans la boutique : **Gestion › Paiements › Envoyer une notification de test**.

Options : `ABANDON_MINUTES` (délai avant de signaler un panier, 10 par défaut, 5 minimum), `NTFY_SERVER` et `NTFY_TOKEN` si vous utilisez votre propre serveur ntfy.

Le nom du sujet sert de mot de passe : toute personne qui le connaît peut lire les notifications. Ne le partagez pas.

## Icône

Le dossier `public` contient l'icône (`icon.svg`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) et `manifest.webmanifest`. Sur téléphone, ouvrez la boutique puis « Ajouter à l'écran d'accueil » : elle s'installe comme une application.
