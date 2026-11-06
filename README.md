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


## Ambassadeurs (affiliation)

Gestion › **Ambassadeurs** : ajoutez une personne (nom et téléphone obligatoires). Elle reçoit un **code** (ex. AWA25) et un **lien** (`/?ref=AWA25`).

- Le client qui arrive par le lien ou tape le code obtient la remise prévue (5 % par défaut). La vente est attribuée à l'ambassadeur pendant 30 jours après le clic.
- Commission : un pourcentage par produit (fiche produit ou lot, « Commission ambassadeur »), sinon le pourcentage par défaut. Elle est calculée sur le prix payé, remise déduite.
- Elle est **validée** quand la commande est payée ou livrée, **annulée** si la commande l'est.
- Bouton **Payer** : enregistre le versement et une dépense « Commissions ambassadeurs » dans la trésorerie.
- Chaque ambassadeur dispose d'un **espace personnel** (lien `/?espace=…`, envoyé par WhatsApp depuis sa fiche) : clics, ventes, gains, versements, commission par produit.


## Partage et promotion (Facebook, WhatsApp)

- **Lien direct par produit** : `https://votre-boutique/?p=ID`, bouton **↗ Partager** dans chaque fiche produit (WhatsApp, Facebook, copier le lien).
- **Aperçu des liens** : le serveur ajoute automatiquement le titre, le prix, la description et la photo du produit (ou l'image `og-image.jpg` de la boutique). Pour rafraîchir un aperçu déjà partagé, utilisez l'outil de débogage de partage de Facebook.
- **Visuel à publier** (équipe) : bouton **🖼 Visuel à publier**, au format carré pour Facebook ou au format vertical pour les statuts WhatsApp, avec le texte de publication prêt à copier.
- **Catalogue Facebook** : `https://votre-boutique/catalogue.csv`, à déclarer dans Meta Commerce Manager (Sources de données › Flux de données › URL, mise à jour quotidienne). Gestion › Produits › **Catalogue Facebook** affiche l'adresse.


## Alertes clients (notifications push)

- Le client touche **« Activer les alertes »** (boutique, Mes commandes ou reçu de commande). Il est ensuite prévenu, avec le logo foûfoûni, quand sa commande passe en Payée, En préparation, Expédiée, Livrée ou Annulée.
- **Gestion › Alertes clients** : envoyez une promo ou une nouveauté à tous les abonnés (avec la photo du produit sur Android). Le bouton « 📣 Annoncer aux clients » d'une fiche produit la prépare automatiquement.
- Aucune configuration : les clés de chiffrement (VAPID) sont créées et stockées automatiquement dans Supabase au premier usage.
- iPhone : le client doit d'abord ajouter la boutique à l'écran d'accueil (iOS 16.4 ou plus récent). Le site l'explique.


## Pages produit et galerie de photos

- Chaque produit a sa **page dédiée** (`/?p=ID`) : galerie de photos (balayage sur téléphone, vignettes sur ordinateur), prix et économie réalisée, quantité, « Ajouter au panier » et « Acheter maintenant », livraison et paiement, garantie, **points forts**, **description détaillée**, **caractéristiques**, lots et produits de la même catégorie. Sur téléphone, une barre d'achat reste visible en bas de l'écran.
- Fiche produit (Gestion) : jusqu'à **8 photos** (★ pour choisir la principale, ✕ pour retirer), points forts (un par ligne), description détaillée, caractéristiques (« Clé : valeur »), garantie / retour.
- Les photos supplémentaires sont servies par `/img/pi/ID` et ajoutées au catalogue Facebook (`additional_image_link`).


## Avis clients (achats vérifiés)

- Quand une commande est **expédiée ou livrée**, le client voit « ★ Donner mon avis » dans **Mes commandes** : note de 1 à 5 sur la qualité, commentaire et jusqu'à 3 **photos réelles**.
- Le serveur vérifie le jeton secret de la commande : seul un vrai acheteur peut noter, une seule fois par produit. L'avis porte la mention « Achat vérifié ».
- Page produit : note moyenne, répartition des étoiles, « Photos des clients », filtre « Avec photos », réponse de la boutique. Les étoiles apparaissent aussi sur les vignettes.
- **Gestion › Avis clients** : répondre publiquement, masquer ou republier un avis. Une notification ntfy signale chaque nouvel avis (prioritaire si 1 ou 2 étoiles).


## Prix d'achat, produits phares et inventaire

- **Prix d'achat** dans la fiche produit (visible uniquement par l'équipe), avec la marge par unité. Colonnes « Achat » et « Marge » dans la liste des produits.
- **Tableau de bord › Produits phares** : quantités vendues, chiffre d'affaires, coût, marge, taux de marge, stock et jours de stock restants, sur 7, 30 ou 90 jours ou depuis le début. Tri par CA, quantité ou marge, export CSV.
- **Gestion › Stock & inventaire** : valeur du stock, inventaire (saisie du stock compté, écarts, validation groupée), ajustements (réception avec nouveau prix d'achat et fournisseur, perte ou casse, correction) et historique des mouvements.


## Variantes et filtres (couleur, taille, pointure…)

- Fiche produit › **Variantes** : jusqu'à 3 options (ex. Couleur : Noir, Blanc · Taille : S, M, L), puis « Créer / mettre à jour les variantes ». Chaque combinaison a son **stock**, un **prix** si différent et un **SKU**. Le stock du produit est la somme des variantes.
- Boutique : **filtres** par valeur d'option (pastilles de couleur), « Disponible uniquement ». Page produit : choix des options, combinaisons épuisées barrées, prix et stock de la variante.
- Panier, caisse (choix de la variante), commandes, inventaire et ajustements fonctionnent variante par variante. Le serveur vérifie la variante, son prix et son stock.
- Les produits à variantes ne peuvent pas être mis dans un lot.


## Produits d'occasion

- Fiche produit › **État** : Neuf, Comme neuf, Très bon état, Bon état, État correct, Reconditionné, avec des **détails sur l'état** (défauts, ancienneté, accessoires).
- Boutique : section « **Bonnes affaires d'occasion** », catégorie **Occasion**, filtre **État**, mention de l'état sur les vignettes et encadré ♻️ sur la page produit.
- Catalogue Facebook : `condition` = new / used / refurbished selon l'état.


## Lots : photos des produits

Sans photo propre, un lot affiche automatiquement un **montage des photos de ses produits** (2 à 4 vignettes), dans la boutique, le panier et la caisse. Chaque produit du lot apparaît avec sa vignette cliquable.

## Assistante IA et relance des paniers abandonnés

- **Variable Render** : `ANTHROPIC_API_KEY`, la clé API créée sur console.anthropic.com. L'usage est facturé par Anthropic selon le nombre de messages. Facultatif : `ANTHROPIC_MODEL` (par défaut `claude-haiku-5-5`).
- Les clients voient une bulle **« Besoin d'aide ? »** : l'assistante répond à partir du catalogue réel (prix, stock, variantes, état, lots, livraison, paiement) et affiche des **fiches produit cliquables**. Elle n'invente ni prix ni promotion, et ne passe pas commande à la place du client. Limite : 30 messages par 10 minutes et par visiteur.
- **Bon retour** : un client qui revient plus de 30 minutes après avoir rempli son panier est accueilli par l'assistante, avec les boutons « Voir mon panier » et « Finaliser ma commande ».
- **Relance automatique par notification** du client qui a activé les alertes, au moment où le panier est considéré abandonné (`ABANDON_MINUTES`). Le code promo de relance est mentionné s'il est choisi.
- **Gestion › Assistant & paniers** : prénom de l'assistante, informations utiles (horaires, adresse…), code promo de relance, liste des paniers abandonnés et bouton **💬 Relancer**, qui prépare un message WhatsApp personnalisé à relire avant l'envoi.


## Studio réseaux sociaux et liens suivis

- **Gestion › Studio réseaux** : choisissez un sujet (la boutique, les soldes, les nouveautés, l'occasion, un code promo, un lot ou un produit), un réseau (Facebook, Instagram, WhatsApp, TikTok, X, LinkedIn, affiche avec QR code) et un format aux bonnes dimensions (publication carrée 1080×1080, portrait 1080×1350, story 1080×1920, couverture Facebook 1640×624, X 1600×900, LinkedIn 1200×627).
- Le visuel est dessiné aux couleurs de la marque, avec un texte de publication adapté au réseau (hashtags pour Instagram et TikTok, texte court pour X…).
- **Liens suivis** : `?src=facebook`, avec `&p=ID` (produit), `&cat=Soldes` (catégorie) ou `&promo=CODE` (le code s'applique tout seul au panier). Les visites (`/api/visit`) et les commandes (`source`) de chaque réseau s'affichent dans le Studio.


## Page de vente par produit (`/?lp=ID`)

- Page longue, pensée pour les publicités : accroche, prix et économie, choix des options, bouton « Commander maintenant » toujours visible, compte à rebours si l'offre a une date de fin.
- **Angles visuels** : chaque photo devient une section légendée (« Sous tous les angles »), zoom en touchant l'image, **vue à 360°** à partir de 4 à 36 photos prises tout autour du produit.
- **Angles de vente** : le problème et la solution, les points forts, « Idéal pour… » (usages), le détail et les caractéristiques, les avis vérifiés, la confiance (livraison, paiement, garantie, contact) et une FAQ complétée automatiquement.
- Fiche produit › **✨ Page de vente** : tous les textes, les légendes des photos et la vue 360°. Le bouton **« Rédiger avec l'assistante »** propose les textes (nécessite `ANTHROPIC_API_KEY`) ; ils ne remplissent que les champs vides et doivent être relus.
- Le Studio réseaux et le bouton Partager donnent le lien de la page de vente ; l'aperçu Facebook et WhatsApp reprend l'accroche.

- **Vidéo** : collez le lien d'une vidéo YouTube (dont Shorts), TikTok, Facebook, Instagram, Vimeo, ou d'une plateforme chinoise : Douyin, Bilibili, Youku, Xigua (lecture dans la page), Kuaishou, Weibo, WeChat (bouton qui ouvre la plateforme), ainsi que les vidéos .mp4 de 1688, Taobao ou AliExpress. Les liens courts (v.douyin.com, b23.tv…) doivent être ouverts une fois pour copier l'adresse complète. Les plateformes chinoises peuvent être lentes ou bloquées hors de Chine.


## Codes-barres, QR codes et terminal de caisse

- **Code-barres EAN-13** pour chaque produit et chaque variante : créé automatiquement (préfixe 2, réservé à l'usage en magasin) ou saisi ou scanné depuis l'emballage du fabricant (fiche produit › Code-barres et QR code).
- **QR code « Scannez pour payer »** : ouvre directement le paiement du produit (`/?pay=ID&v=variante`) sur le téléphone du client. Il est affiché en miniature sur la page produit et sur les étiquettes.
- **Étiquettes** : Gestion › Produits › 🏷️ Étiquettes (ou depuis une fiche). Formats thermique 50 × 30 mm, feuille A4 63 × 34 mm, colis 100 × 50 mm. Chaque étiquette porte le nom, le prix, le code-barres et le QR code.
- **Caisse façon terminal** : écran d'affichage, champ de scan, **douchette USB ou Bluetooth** (aucun réglage : elle tape le code et Entrée), **caméra** du téléphone ou de la tablette, bip de confirmation. Un code inconnu est signalé.
- **QR de paiement** à la caisse : le terminal affiche un QR code avec le montant, le client le scanne et paie par Wave ou Orange Money sur son téléphone (`/api/admin/pos/qr-order`, `/api/orders/:id/pay`). L'écran passe à « Paiement reçu ✓ » dès la confirmation.


## Import par scan : créer, modifier, réceptionner

- **Gestion › Produits › 📷 Scanner un produit** (douchette ou caméra) : un code déjà en stock ouvre la fiche pour la modifier ; un code nouveau est recherché dans **Open Food Facts, Open Beauty Facts, Open Products Facts** puis **UPCitemdb** (`/api/admin/lookup-barcode`). Nom, marque, contenance, photo et catégorie pré-remplissent la fiche ; il reste à saisir le prix, la quantité et le prix d'achat.
- **Caisse** : un code inconnu scanné par l'équipe propose de créer l'article.
- **Stock & inventaire › Réception par scan** : chaque scan ajoute +1 à la réception (un code inconnu ouvre la création), puis « Valider la réception » met le stock à jour avec un mouvement « Réception par scan ».
- Les bases publiques couvrent surtout les produits de marque internationaux ; les produits locaux sans code connu se créent à la main, code-barres déjà rempli. UPCitemdb (version gratuite) limite à environ 100 recherches par jour.


## Livreurs et photo du colis livré

- **Gestion › Commandes › 🛵 Livreurs** : ajoutez vos livreurs (nom, téléphone) et envoyez à chacun son **espace livreur** (lien secret `/?livreur=…`).
- Dans chaque commande à livrer : choisissez le livreur, appelez-le ou **envoyez-lui la course sur WhatsApp** (client, adresse, articles, montant à encaisser, lien de son espace).
- **Espace livreur** (téléphone) : ses livraisons du moment, boutons Appeler, WhatsApp et Itinéraire, puis **📷 Colis livré : prendre la photo**. La commande passe en « Livrée », le stock est déduit, le montant encaissé est noté, et vous recevez une notification.
- Dans la commande : la photo s'affiche, et **📤 Envoyer la photo au client** partage l'image sur WhatsApp (ou envoie un lien vers la photo). Le client voit aussi la photo dans « Mes commandes ».
- La boutique peut aussi ajouter la photo elle-même depuis la commande. Les photos ne sont visibles que par l'équipe et par le client concerné.


## Informations de la société (Gestion › Société)

Nom commercial, sous-titre de l'en-tête, raison sociale, forme juridique, capital, RCCM, NIF, adresse, ville, pays, téléphones, WhatsApp, e-mail, horaires et message en bas des reçus. Elles s'affichent dans l'en-tête, le pied de page, les reçus et tickets de caisse, et sont connues de l'assistante. Un aperçu se met à jour pendant la saisie.
