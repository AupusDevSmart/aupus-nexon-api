export function getWelcomeEmailHtml(
  nome: string,
  senhaTemporaria: string,
  loginUrl: string,
  frontendUrl: string,
): string {
  const logoUrl = `${frontendUrl}/logoaupus.png`;

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bem-vindo ao Aupus</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f5f7; padding: 40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width: 560px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background-color: #1a1a2e; padding: 32px 40px; border-radius: 8px 8px 0 0; text-align: center;">
              <img src="${logoUrl}" alt="Aupus" width="140" style="display: block; margin: 0 auto;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; padding: 40px;">
              <h1 style="margin: 0 0 24px; font-size: 22px; font-weight: 600; color: #1a1a2e;">
                Bem-vindo ao Aupus
              </h1>

              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #374151;">
                Prezado(a) <strong>${nome}</strong>,
              </p>

              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #374151;">
                Sua conta foi criada no sistema Aupus. Utilize as credenciais abaixo para realizar o seu primeiro acesso.
              </p>

              <!-- Credentials Box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
                <tr>
                  <td style="background-color: #f8f9fb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 20px 24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size: 13px; color: #6b7280; padding-bottom: 8px;">Senha temporária</td>
                      </tr>
                      <tr>
                        <td style="font-size: 20px; font-weight: 600; color: #1a1a2e; letter-spacing: 1px; font-family: 'Courier New', monospace;">${senhaTemporaria}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #374151;">
                Após o primeiro acesso, recomendamos que altere sua senha imediatamente através da página de perfil do sistema.
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
                <tr>
                  <td style="border-radius: 6px; background-color: #1a1a2e;">
                    <a href="${loginUrl}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 6px;">
                      Acessar o Sistema
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 24px 0 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
                Caso não tenha solicitado esta conta, desconsidere este email ou entre em contato com o administrador do sistema.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fb; padding: 24px 40px; border-radius: 0 0 8px 8px; border-top: 1px solid #e5e7eb; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} Aupus. Todos os direitos reservados.
              </p>
              <p style="margin: 8px 0 0; font-size: 12px; color: #9ca3af;">
                Este é um email automático. Por favor, não responda.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}
